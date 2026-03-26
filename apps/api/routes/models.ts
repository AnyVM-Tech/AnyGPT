import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import { dataManager, ModelsFileStructure } from '../modules/dataManager.js'; // For serving the main models.json
import { logError } from '../modules/errorLogger.js'; // Changed import
import { enforceInMemoryRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { extractBearerToken, readTierRateLimitsFromEnv, runAuthMiddleware, runIpRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { validateApiKeyAndUsage } from '../modules/userData.js';
import { buildPublicPlanPayload, filterModelsForTier } from '../modules/planAccess.js';

const modelsRouter = new HyperExpress.Router();

const publicModelsRequestStore: RequestTimestampStore = {};
const adminModelsRequestStore: RequestTimestampStore = {};
const publicModelsRateLimits = readTierRateLimitsFromEnv('PUBLIC_MODELS', { rps: 10, rpm: 120, rpd: 5000 });
const adminRouteRateLimits = readTierRateLimitsFromEnv('ADMIN_ROUTE_RATE_LIMIT', { rps: 10, rpm: 300, rpd: 5000 });
const debugIpRouteEnabled = process.env.ENABLE_DEBUG_IP_ROUTE === '1';

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
        const modelsData = await dataManager.load<ModelsFileStructure>('models');
        const authHeader = request.headers['authorization'] || request.headers['Authorization'];
        const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
        const apiKey =
            bearer
            || (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null)
            || (typeof request.headers['api-key'] === 'string' ? request.headers['api-key'] : null);
        const includePlan = request.query?.include_plan === '1' || request.query?.includePlan === '1';

        if (!apiKey) {
            return response.json(modelsData);
        }

        const validation = await validateApiKeyAndUsage(apiKey);
        if (!validation.valid || !validation.userData || !validation.tierLimits) {
            const statusCode = validation.error?.includes('limit reached') ? 429 : 401;
            return response.status(statusCode).json({
                error: statusCode === 429 ? 'Rate limit exceeded' : 'Unauthorized',
                message: validation.error || 'Invalid API key.',
                timestamp: new Date().toISOString(),
            });
        }

        const tierId = validation.userData.tier;
        const tier = validation.tierLimits;
        const filtered = filterModelsForTier(modelsData, tier);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-AnyGPT-Plan', tierId);
        response.setHeader('X-AnyGPT-Visible-Models', String(Array.isArray(filtered.data) ? filtered.data.length : 0));
        if (includePlan) {
            return response.json({
                ...filtered,
                plan: buildPublicPlanPayload(tierId, tier, {
                    visibleModelCount: Array.isArray(filtered.data) ? filtered.data.length : 0,
                }),
            });
        }
        response.json(filtered);
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

// Route to serve the main models.json (models.json in current directory)
modelsRouter.get('/v1/models', publicModelsRateLimitMiddleware, sendModelsResponse);

// OpenAI-compatible aliases so clients can hit chat completion model discovery
modelsRouter.get('/v1/chat/completions/models', publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/chat/completion/models', publicModelsRateLimitMiddleware, sendModelsResponse);

export { modelsRouter };
