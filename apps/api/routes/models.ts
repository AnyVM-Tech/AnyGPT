import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import { dataManager, LoadedProviders, ModelsFileStructure } from '../modules/dataManager.js'; // For serving the main models.json
import { logError } from '../modules/errorLogger.js'; // Changed import
import { enforceInMemoryRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { extractBearerToken, readTierRateLimitsFromEnv, runAuthMiddleware, runIpRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { validateApiKeyAndUsage } from '../modules/userData.js';
import { buildPublicPlanPayload, filterModelsForTier } from '../modules/planAccess.js';
import { applyLiveProviderCountsToModelsData } from '../modules/modelUpdater.js';

const modelsRouter = new HyperExpress.Router();

const publicModelsRequestStore: RequestTimestampStore = {};
const adminModelsRequestStore: RequestTimestampStore = {};
const publicModelsRateLimits = readTierRateLimitsFromEnv('PUBLIC_MODELS', { rps: 10, rpm: 120, rpd: 5000 });
const adminRouteRateLimits = readTierRateLimitsFromEnv('ADMIN_ROUTE_RATE_LIMIT', { rps: 10, rpm: 300, rpd: 5000 });
const debugIpRouteEnabled = process.env.ENABLE_DEBUG_IP_ROUTE === '1';
const MODELS_LIVE_POLL_MS = Math.max(500, Number(process.env.MODELS_LIVE_POLL_MS ?? 2000));
const MODELS_LIVE_HEARTBEAT_MS = Math.max(1000, Number(process.env.MODELS_LIVE_HEARTBEAT_MS ?? 15000));

type PreparedModelsPayload =
    | { ok: true; body: any; headers: Record<string, string>; serialized: string }
    | { ok: false; statusCode: number; body: any; headers?: Record<string, string> };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function applyResponseHeaders(response: Response, headers: Record<string, string> | undefined): void {
    if (!headers) return;
    for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
    }
}

function extractRequestApiKey(request: any): string | null {
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
    const queryApiKey = typeof request.query?.api_key === 'string'
        ? request.query.api_key
        : typeof request.query?.apiKey === 'string'
            ? request.query.apiKey
            : typeof request.query?.x_api_key === 'string'
                ? request.query.x_api_key
                : null;
    return (
        bearer
        || (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null)
        || (typeof request.headers['api-key'] === 'string' ? request.headers['api-key'] : null)
        || queryApiKey
    );
}

export async function buildModelsPayload(request: any): Promise<PreparedModelsPayload> {
    const [modelsSnapshot, providersData] = await Promise.all([
        dataManager.load<ModelsFileStructure>('models'),
        dataManager.load<LoadedProviders>('providers'),
    ]);
    if (!modelsSnapshot || !Array.isArray(modelsSnapshot.data)) {
        throw new Error('Failed to load models data.');
    }

    const liveCountsUpdatedAt = new Date().toISOString();
    const modelsData = applyLiveProviderCountsToModelsData(
        modelsSnapshot,
        providersData || [],
        Date.now()
    );
    const apiKey = extractRequestApiKey(request);
    const includePlan = request.query?.include_plan === '1' || request.query?.includePlan === '1';

    if (!apiKey) {
        const body = {
            ...modelsData,
            provider_counts_live: true,
            provider_counts_updated_at: liveCountsUpdatedAt,
        };
        return {
            ok: true,
            body,
            serialized: JSON.stringify(body),
            headers: {
                'Cache-Control': 'private, no-store',
                'X-AnyGPT-Provider-Counts-Live': '1',
                'X-AnyGPT-Provider-Counts-Updated-At': liveCountsUpdatedAt,
            },
        };
    }

    const validation = await validateApiKeyAndUsage(apiKey);
    if (!validation.valid || !validation.userData || !validation.tierLimits) {
        const statusCode = validation.error?.includes('limit reached') ? 429 : 401;
        return {
            ok: false,
            statusCode,
            body: {
                error: statusCode === 429 ? 'Rate limit exceeded' : 'Unauthorized',
                message: validation.error || 'Invalid API key.',
                timestamp: new Date().toISOString(),
            },
        };
    }

    const tierId = validation.userData.tier;
    const tier = validation.tierLimits;
    const filtered = filterModelsForTier(modelsData, tier);
    const visibleModelCount = Array.isArray(filtered.data) ? filtered.data.length : 0;
    const totalModelCount = Array.isArray(modelsData?.data) ? modelsData.data.length : visibleModelCount;
    const catalogUpdatedAt = typeof (modelsData as any)?.updated_at === 'string'
        ? (modelsData as any).updated_at
        : '';
    const visibleProviderCount = filtered.data.reduce((sum, model) => sum + (typeof model.providers === 'number' ? model.providers : 0), 0);
    const totalProviderCount = modelsData.data.reduce((sum, model) => sum + (typeof model.providers === 'number' ? model.providers : 0), 0);
    const constrainedVisibleModelCount = filtered.data.reduce((sum, model) => {
        const availability = (model as any)?.availability;
        const blocked = Array.isArray(availability?.capability_blocked) ? availability.capability_blocked.length : 0;
        const skips = availability?.capability_skips && typeof availability.capability_skips === 'object'
            ? Object.keys(availability.capability_skips).length
            : 0;
        return sum + (blocked > 0 || skips > 0 ? 1 : 0);
    }, 0);
    const constrainedTotalModelCount = modelsData.data.reduce((sum, model) => {
        const availability = (model as any)?.availability;
        const blocked = Array.isArray(availability?.capability_blocked) ? availability.capability_blocked.length : 0;
        const skips = availability?.capability_skips && typeof availability.capability_skips === 'object'
            ? Object.keys(availability.capability_skips).length
            : 0;
        return sum + (blocked > 0 || skips > 0 ? 1 : 0);
    }, 0);

    const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store',
        'X-AnyGPT-Provider-Counts-Live': '1',
        'X-AnyGPT-Provider-Counts-Updated-At': liveCountsUpdatedAt,
        'X-AnyGPT-Plan': tierId,
        'X-AnyGPT-Visible-Models': String(visibleModelCount),
        'X-AnyGPT-Total-Models': String(totalModelCount),
        'X-AnyGPT-Visible-Providers': String(visibleProviderCount),
        'X-AnyGPT-Total-Providers': String(totalProviderCount),
        'X-AnyGPT-Visible-Constrained-Models': String(constrainedVisibleModelCount),
        'X-AnyGPT-Total-Constrained-Models': String(constrainedTotalModelCount),
        'X-AnyGPT-Models-Filtered': visibleModelCount === totalModelCount ? '0' : '1',
        'X-AnyGPT-Providers-Filtered': visibleProviderCount === totalProviderCount ? '0' : '1',
        'X-AnyGPT-Availability-Constrained': constrainedVisibleModelCount > 0 ? '1' : '0',
        'X-AnyGPT-Availability-Constrained-Only': visibleModelCount > 0 && visibleModelCount === constrainedVisibleModelCount ? '1' : '0',
        'X-AnyGPT-Availability-Unconstrained-Models': String(Math.max(visibleModelCount - constrainedVisibleModelCount, 0)),
        'X-AnyGPT-Plan-Included': includePlan ? '1' : '0',
    };
    if (catalogUpdatedAt) {
        headers['X-AnyGPT-Models-Updated-At'] = catalogUpdatedAt;
    }
    const catalogState = !catalogUpdatedAt
        ? 'missing-updated-at'
        : visibleModelCount === 0
            ? 'empty'
            : constrainedVisibleModelCount > 0
                ? 'availability-constrained'
                : visibleModelCount < totalModelCount || visibleProviderCount < totalProviderCount
                    ? 'filtered'
                    : 'fresh';
    headers['X-AnyGPT-Models-Catalog-State'] = catalogState;

    const baseBody: any = {
        ...filtered,
        provider_counts_live: true,
        provider_counts_updated_at: liveCountsUpdatedAt,
    };
    if (includePlan) {
        baseBody.plan = buildPublicPlanPayload(tierId, tier, {
            visibleModelCount,
        });
    }
    return {
        ok: true,
        body: baseBody,
        serialized: JSON.stringify(baseBody),
        headers,
    };
}

async function publicModelsRateLimitMiddleware(request: Request, response: Response, next: () => void) {
    return runIpRateLimitMiddleware(request, response, next, publicModelsRequestStore, publicModelsRateLimits, {
        onDenied: async (_req, details) => ({
            status: 429,
            body: {
                error: 'Rate limit exceeded',
                message: `Public models route limit exceeded (${details.limit} ${details.window.toUpperCase()}).`,
                retry_after_seconds: details.retryAfterSeconds,
                timestamp: new Date().toISOString(),
            }
        }),
    });
}

async function adminRouteSecurityMiddleware(request: Request, response: Response, next: () => void) {
    await runAuthMiddleware(request, response, () => {}, {
        callNext: false,
        extractApiKey: (req) => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'];
            const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
            if (bearer) return bearer;
            if (typeof req.headers['x-api-key'] === 'string') return req.headers['x-api-key'];
            if (typeof req.headers['api-key'] === 'string') return req.headers['api-key'];
            return null;
        },
        onMissingApiKey: async (req) => {
            await logError({ message: 'Unauthorized: Missing admin API key for models admin route', requestPath: req.path }, req);
            return { status: 401, body: { error: 'Unauthorized', message: 'Admin API key required.', timestamp: new Date().toISOString() } };
        },
        onInvalidApiKey: async (req, details) => {
            await logError({ message: `Unauthorized: ${details.error || 'Invalid API key'} for models admin route`, requestPath: req.path }, req);
            return { status: details.statusCode, body: { error: 'Unauthorized', message: details.error || 'Invalid API key.', timestamp: new Date().toISOString() } };
        },
        onInternalError: async (req, error) => {
            await logError(error, req);
            return { status: 500, body: { error: 'Internal Server Error', reference: 'Authentication failed for models admin route.', timestamp: new Date().toISOString() } };
        },
    });

    if (!request.apiKey || request.userRole !== 'admin') {
        if (request.apiKey) {
            await logError({ message: 'Forbidden: Admin access required for models admin route', requestPath: request.path, userRole: request.userRole }, request);
        }
        if (!response.completed) {
            return response.status(403).json({ error: 'Forbidden', message: 'Admin access required.', timestamp: new Date().toISOString() });
        }
        return;
    }

    const rateKey = request.apiKey || request.userId || 'admin-route';
    const decision = enforceInMemoryRateLimit(adminModelsRequestStore, rateKey, adminRouteRateLimits);
    if (!decision.allowed && decision.window) {
        const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
        response.setHeader('Retry-After', String(retryAfterSeconds));
        await logError({
            message: `Rate limit exceeded for protected models route (${decision.window.toUpperCase()}).`,
            requestPath: request.path,
            rateLimitWindow: decision.window,
            rateLimitLimit: decision.limit ?? adminRouteRateLimits[decision.window],
            retryAfterSeconds,
        }, request);
        if (!response.completed) {
            return response.status(429).json({
                error: 'Rate limit exceeded',
                message: `Admin route limit exceeded (${decision.limit ?? adminRouteRateLimits[decision.window]} ${decision.window.toUpperCase()}).`,
                retry_after_seconds: retryAfterSeconds,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    next();
}

if (debugIpRouteEnabled) {
    // Debug route is disabled by default and admin-only when enabled.
    modelsRouter.get('/debug/ip', adminRouteSecurityMiddleware, (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.json({
            ip: (request as any).ip,
            xForwardedFor: request.headers['x-forwarded-for'],
            xRealIp: request.headers['x-real-ip'],
            cfConnectingIp: request.headers['cf-connecting-ip'],
            forwarded: request.headers['forwarded'],
            timestamp: new Date().toISOString(),
        });
    });
}

async function sendModelsResponse(request: any, response: any) {
    try {
        const payload = await buildModelsPayload(request);
        applyResponseHeaders(response, payload.headers);
        if (!payload.ok) {
            return response.status(payload.statusCode).json(payload.body);
        }
        response.json(payload.body);
    } catch (error) {
        await logError(error, request);
        console.error('Error serving models.json:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load models data.',
                timestamp: new Date().toISOString()
            });
        } else {
             console.warn('[GET /models] Response already completed, could not send 500 JSON error.');
        }
    }
}

async function sendModelsLiveSseResponse(request: any, response: any) {
    try {
        const initialPayload = await buildModelsPayload(request);
        applyResponseHeaders(response, initialPayload.headers);
        if (!initialPayload.ok) {
            return response.status(initialPayload.statusCode).json(initialPayload.body);
        }

        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');

        let lastSerialized = initialPayload.serialized;
        let lastHeartbeatAt = Date.now();

        response.write(`event: models\n`);
        response.write(`data: ${initialPayload.serialized}\n\n`);

        void (async () => {
            try {
                while (!response.completed) {
                    await sleep(MODELS_LIVE_POLL_MS);
                    if (response.completed) break;

                    const nextPayload = await buildModelsPayload(request);
                    if (!nextPayload.ok) {
                        response.write('event: error\n');
                        response.write(`data: ${JSON.stringify(nextPayload.body)}\n\n`);
                        response.end();
                        break;
                    }

                    if (nextPayload.serialized !== lastSerialized) {
                        lastSerialized = nextPayload.serialized;
                        lastHeartbeatAt = Date.now();
                        response.write('event: models\n');
                        response.write(`data: ${nextPayload.serialized}\n\n`);
                        continue;
                    }

                    if (Date.now() - lastHeartbeatAt >= MODELS_LIVE_HEARTBEAT_MS) {
                        lastHeartbeatAt = Date.now();
                        response.write(`: heartbeat ${new Date(lastHeartbeatAt).toISOString()}\n\n`);
                    }
                }
            } catch (streamError) {
                await logError(streamError, request);
                if (!response.completed) {
                    response.write('event: error\n');
                    response.write(`data: ${JSON.stringify({
                        error: 'Internal Server Error',
                        reference: 'Failed to stream live models data.',
                        timestamp: new Date().toISOString(),
                    })}\n\n`);
                    response.end();
                }
            }
        })();
    } catch (error) {
        await logError(error, request);
        console.error('Error serving live models SSE:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to stream live models data.',
                timestamp: new Date().toISOString(),
            });
        }
    }
}

// Route to serve the main models.json (models.json in current directory)
modelsRouter.get('/v1/models', publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/models/live', publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);

// OpenAI-compatible aliases so clients can hit chat completion model discovery
modelsRouter.get('/v1/chat/completions/models', publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/chat/completion/models', publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/chat/completions/models/live', publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);
modelsRouter.get('/v1/chat/completion/models/live', publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);

export { modelsRouter };
