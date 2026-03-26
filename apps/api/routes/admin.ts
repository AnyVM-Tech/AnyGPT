import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'node:readline';
import crypto from 'crypto';
import { addOrUpdateProvider } from '../server/addProvider.js';
import {
    generateUserApiKey,
    resetUserUsageAccounting,
    settleUserBillingPeriod,
    type TierData,
} from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js';
import { notifyAdminKeyReceived } from '../modules/adminKeySync.js';
import {
    validateAdminGenerateKeyPayload,
    validateAdminProviderPayload,
    formatAjvErrors,
    validateAdminKeyIngestPayload,
    validateAdminApiKeySelector,
    validateAdminApiKeyUpdatePayload,
    validateAdminApiKeyRotatePayload,
} from '../modules/validators.js';
import { redactToken } from '../modules/redaction.js';
import { enforceInMemoryRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { dataManager, type KeysFile, type LoadedProviders, type ModelsFileStructure } from '../modules/dataManager.js';
import { deriveKeyUsageSnapshot } from '../modules/keyUsage.js';
import { buildPublicPlanPayload } from '../modules/planAccess.js';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';
import { readTierRateLimitsFromEnv } from '../modules/middlewareFactory.js';
import { getProviderStatsQueueSnapshots } from '../providers/handler.js';
import { getOpenAiAdmissionQueueSnapshots } from './openai.js';
import { getFleetInstances } from '../modules/fleetCoordinator.js';
import {
    getFallbackUserTierId,
    getTiersFilePath,
    loadTiers,
    mergeTierPatch,
    normalizeTierData,
    normalizeTiersFile,
    saveTiers,
    type TiersFile,
} from '../modules/tierManager.js';

const adminRouter = new HyperExpress.Router();
const configuredLogDirectory = (process.env.ANYGPT_LOG_DIR || '').trim();
const logDirectory = configuredLogDirectory
    ? path.resolve(configuredLogDirectory)
    : path.resolve('logs');
const adminKeysLogPath = path.join(logDirectory, 'admin-keys.jsonl');
const legacyAdminKeysLogPath = path.join(logDirectory, 'admin-keys.json');
const parsedMaxEntries = parseInt(process.env.ADMIN_KEYS_LOG_MAX_ENTRIES || '1000', 10);
const parsedMaxBytes = parseInt(process.env.ADMIN_KEYS_LOG_MAX_BYTES || '5242880', 10);
const adminKeysLogMaxEntries = Number.isFinite(parsedMaxEntries) ? Math.max(1, parsedMaxEntries) : 1000;
const adminKeysLogMaxBytes = Number.isFinite(parsedMaxBytes) ? Math.max(1024, parsedMaxBytes) : 5242880;
const parsedAdminKeysRps = parseInt(process.env.ADMIN_KEYS_RATE_LIMIT_RPS || '5', 10);
const parsedAdminKeysRpm = parseInt(process.env.ADMIN_KEYS_RATE_LIMIT_RPM || '60', 10);
const parsedAdminKeysRpd = parseInt(process.env.ADMIN_KEYS_RATE_LIMIT_RPD || '1000', 10);
const adminKeysRateLimits = {
    rps: Number.isFinite(parsedAdminKeysRps) ? Math.max(0, parsedAdminKeysRps) : 5,
    rpm: Number.isFinite(parsedAdminKeysRpm) ? Math.max(0, parsedAdminKeysRpm) : 60,
    rpd: Number.isFinite(parsedAdminKeysRpd) ? Math.max(0, parsedAdminKeysRpd) : 1000,
};
const adminKeysMaxBodyBytes = (() => {
    const parsed = parseInt(process.env.ADMIN_KEYS_MAX_BODY_BYTES || '4096', 10);
    return Number.isFinite(parsed) ? Math.max(256, parsed) : 4096;
})();
const adminKeysAllowedProviders = (() => {
    const raw = process.env.ADMIN_KEYS_ALLOWED_PROVIDERS;
    if (!raw) return null;
    const set = new Set<string>();
    raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).forEach((p) => set.add(p));
    return set.size > 0 ? set : null;
})();
const adminKeyIngestStore: RequestTimestampStore = {};
const adminProtectedRouteStore: RequestTimestampStore = {};
const adminProtectedRouteRateLimits = readTierRateLimitsFromEnv('ADMIN_ROUTE_RATE_LIMIT', { rps: 10, rpm: 300, rpd: 5000 });

function normalizeTierId(tiers: TiersFile, tier?: string): string | null {
    if (!tier) return null;
    const normalized = tier.trim();
    if (!normalized) return null;
    return tiers[normalized] ? normalized : null;
}

function summarizeApiKey(apiKey: string, user: KeysFile[string], tiers: TiersFile) {
    const tier = tiers[user.tier];
    const usage = deriveKeyUsageSnapshot(user, tier);
    return {
        apiKeyMasked: redactToken(apiKey),
        apiKeyHash: deriveApiKeyIdentifier(apiKey),
        userId: user.userId,
        role: user.role,
        tier: user.tier,
        plan: buildPublicPlanPayload(user.tier, tier),
        tokenUsage: usage.totalTokenUsage,
        totalTokenUsage: usage.totalTokenUsage,
        paidTokenUsage: usage.paidTokenUsage,
        billingPeriodTokenUsage: usage.billingPeriodTokenUsage,
        outstandingTokenUsage: usage.outstandingTokenUsage,
        requestCount: usage.totalRequestCount,
        totalRequestCount: usage.totalRequestCount,
        paidRequestCount: usage.paidRequestCount,
        billingPeriodRequestCount: usage.billingPeriodRequestCount,
        outstandingRequestCount: usage.outstandingRequestCount,
        currentDayRequestDate: usage.currentDayRequestDate,
        currentDayRequestCount: usage.currentDayRequestCount,
        dailyRequestTarget: usage.dailyRequestTarget,
        dailyRequestTargetRemaining: usage.dailyRequestTargetRemaining,
        dailyRequestHardCap: usage.dailyRequestHardCap,
        dailyRequestHardCapRemaining: usage.dailyRequestHardCapRemaining,
        dailyRequestWarningActive: usage.dailyRequestWarningActive,
        dailyRequestWarningExceededBy: usage.dailyRequestWarningExceededBy,
        billingPeriodRequestTarget: usage.billingPeriodRequestTarget,
        billingPeriodRequestTargetRemaining: usage.billingPeriodRequestTargetRemaining,
        estimatedCost: usage.totalEstimatedCost,
        totalEstimatedCost: usage.totalEstimatedCost,
        paidEstimatedCost: usage.paidEstimatedCost,
        billingPeriodEstimatedCost: usage.billingPeriodEstimatedCost,
        outstandingEstimatedCost: usage.outstandingEstimatedCost,
        billingPeriodStartedAt: usage.billingPeriodStartedAt,
        lastBillingSettlementAt: usage.lastBillingSettlementAt,
        warnings: usage.warnings,
        warningTicker: usage.warningTicker,
    };
}

function deriveApiKeyIdentifier(apiKey: string): string {
    // Use a computationally expensive KDF to derive a short, non-reversible identifier.
    const salt = 'admin-api-key-summary';
    const iterations = 100000;
    const keyLength = 32;
    const digest = 'sha256';

    const derived = crypto.pbkdf2Sync(apiKey, salt, iterations, keyLength, digest);
    return derived.toString('hex').slice(0, 12);
}

function resolveApiKeySelector(keys: KeysFile, selector: { apiKey?: string; userId?: string }): { apiKey: string; user: KeysFile[string] } | null {
    if (selector.apiKey && keys[selector.apiKey]) {
        return { apiKey: selector.apiKey, user: keys[selector.apiKey] };
    }
    if (selector.userId) {
        for (const [apiKey, user] of Object.entries(keys)) {
            if (user?.userId === selector.userId) {
                return { apiKey, user };
            }
        }
    }
    return null;
}

function buildTierUsageSummary(keys: KeysFile, tierId: string) {
    let assignedKeys = 0;
    let adminKeys = 0;
    let userKeys = 0;
    const sampleUserIds: string[] = [];

    for (const user of Object.values(keys)) {
        if (!user || user.tier !== tierId) continue;
        assignedKeys += 1;
        if (user.role === 'admin') adminKeys += 1;
        if (user.role === 'user') userKeys += 1;
        if (sampleUserIds.length < 10 && typeof user.userId === 'string' && user.userId.trim()) {
            sampleUserIds.push(user.userId);
        }
    }

    return {
        assignedKeys,
        adminKeys,
        userKeys,
        sampleUserIds,
    };
}

function buildTierResponse(tierId: string, tier: TierData, keys: KeysFile) {
    return {
        id: tierId,
        tier,
        usage: buildTierUsageSummary(keys, tierId),
    };
}

function unwrapTierPayload(body: any): unknown {
    if (body && typeof body === 'object' && !Array.isArray(body) && 'tier' in body) {
        return (body as Record<string, unknown>).tier;
    }
    return body;
}

function unwrapTiersPayload(body: any): unknown {
    if (body && typeof body === 'object' && !Array.isArray(body) && 'tiers' in body) {
        return (body as Record<string, unknown>).tiers;
    }
    return body;
}

function getRequestIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
        return String(forwarded[0]).trim();
    }
    return request.ip || request.headers['x-real-ip']?.toString() || 'unknown';
}

async function rotateAdminKeysLogIfNeeded(): Promise<void> {
    try {
        const stat = await fs.promises.stat(adminKeysLogPath);
        if (stat.size <= adminKeysLogMaxBytes) return;
        const rotatedPath = `${adminKeysLogPath}.1`;
        try {
            await fs.promises.unlink(rotatedPath);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        await fs.promises.rename(adminKeysLogPath, rotatedPath);
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.warn(`[admin/keys] Failed rotating log file: ${error.message}`);
        }
    }
}

async function migrateLegacyAdminKeysLogIfNeeded(): Promise<void> {
    try {
        await fs.promises.access(adminKeysLogPath);
        return;
    } catch (error: any) {
        if (error.code !== 'ENOENT') return;
    }

    try {
        const raw = await fs.promises.readFile(legacyAdminKeysLogPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        await fs.promises.mkdir(path.dirname(adminKeysLogPath), { recursive: true });
        const lines = parsed.map((entry) => JSON.stringify(entry)).join('\n');
        await fs.promises.writeFile(adminKeysLogPath, lines ? `${lines}\n` : '', 'utf8');
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.warn(`[admin/keys] Failed migrating legacy log file: ${error.message}`);
        }
    }
}

async function appendAdminKeyLog(entry: Record<string, any>) {
    await fs.promises.mkdir(path.dirname(adminKeysLogPath), { recursive: true });
    await migrateLegacyAdminKeysLogIfNeeded();
    await rotateAdminKeysLogIfNeeded();
    await fs.promises.appendFile(adminKeysLogPath, JSON.stringify(entry) + '\n', 'utf8');
}

async function readAdminKeyLog(): Promise<{ entries: any[]; total: number }> {
    await migrateLegacyAdminKeysLogIfNeeded();
    try {
        await fs.promises.access(adminKeysLogPath);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return { entries: [], total: 0 };
        }
        throw error;
    }

    const entries: any[] = [];
    let total = 0;

    const stream = fs.createReadStream(adminKeysLogPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        total += 1;
        try {
            const parsed = JSON.parse(trimmed);
            if (entries.length >= adminKeysLogMaxEntries) {
                entries.shift();
            }
            entries.push(parsed);
        } catch {
            // Skip malformed lines
        }
    }

    return { entries, total };
}

// Admin Authentication Middleware (apply only to sensitive routes)
const adminOnlyMiddleware = (request: Request, response: Response, next: () => void) => {
    if (request.userRole !== 'admin') {
        logError({ message: 'Forbidden: Admin access required.', attemptedPath: request.url, userRole: request.userRole, apiKey: redactToken(request.apiKey) }, request).catch(e => console.error('Failed background log:', e));
        if (!response.completed) {
            return response.status(403).json({
                error: 'Forbidden',
                message: 'Admin access required.',
                timestamp: new Date().toISOString()
            });
        }
        return;
    }

    const rateKey = request.apiKey || request.userId || getRequestIp(request);
    const rateDecision = enforceInMemoryRateLimit(adminProtectedRouteStore, rateKey, adminProtectedRouteRateLimits);
    if (!rateDecision.allowed && rateDecision.window) {
        const retryAfterSeconds = rateDecision.retryAfterSeconds ?? 1;
        response.setHeader('Retry-After', String(retryAfterSeconds));
        logError({
            message: `Rate limit exceeded for protected admin route (${rateDecision.window.toUpperCase()}).`,
            attemptedPath: request.url,
            userId: request.userId,
            userRole: request.userRole,
            rateLimitWindow: rateDecision.window,
            rateLimitLimit: rateDecision.limit ?? adminProtectedRouteRateLimits[rateDecision.window],
            retryAfterSeconds,
        }, request).catch(e => console.error('Failed background log:', e));
        if (!response.completed) {
            return response.status(429).json({
                error: 'Rate limit exceeded',
                message: `Admin route limit exceeded (${rateDecision.limit ?? adminProtectedRouteRateLimits[rateDecision.window]} ${rateDecision.window.toUpperCase()}).`,
                retry_after_seconds: retryAfterSeconds,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    next();
};

adminRouter.get('/tiers', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const [tiers, keys] = await Promise.all([
            loadTiers(),
            dataManager.load<KeysFile>('keys'),
        ]);
        const entries = Object.entries(tiers).map(([tierId, tier]) => buildTierResponse(tierId, tier, keys));
        response.json({
            filePath: getTiersFilePath(),
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load tiers.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

adminRouter.put('/tiers', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        let payload: any;
        try {
            payload = await request.json();
        } catch (parseError: any) {
            await logError({ message: 'Bad Request: Invalid JSON payload for tiers replace', parseError: parseError?.message }, request);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid JSON payload.',
                timestamp: new Date().toISOString(),
            });
        }

        const normalized = normalizeTiersFile(unwrapTiersPayload(payload));
        if (Object.keys(normalized).length === 0) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'At least one tier is required.',
                timestamp: new Date().toISOString(),
            });
        }

        const keys = await dataManager.load<KeysFile>('keys');
        const missingAssignedTierIds = [...new Set(
            Object.values(keys)
                .map((user) => user?.tier)
                .filter((tierId): tierId is string => typeof tierId === 'string' && !!tierId && !normalized[tierId])
        )];
        if (missingAssignedTierIds.length > 0) {
            return response.status(409).json({
                error: 'Conflict',
                message: 'Cannot replace tiers because one or more existing API keys would reference missing tiers.',
                missingAssignedTierIds,
                timestamp: new Date().toISOString(),
            });
        }

        const saved = await saveTiers(normalized);
        const entries = Object.entries(saved).map(([tierId, tier]) => buildTierResponse(tierId, tier, keys));
        response.json({
            message: 'Tiers replaced successfully.',
            filePath: getTiersFilePath(),
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(400).json({
                error: 'Bad Request',
                message: error?.message || 'Failed to replace tiers.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

adminRouter.get('/tiers/:tierId', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const tierId = String(request.params.tierId || '').trim();
        if (!tierId) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'tierId is required.',
                timestamp: new Date().toISOString(),
            });
        }

        const [tiers, keys] = await Promise.all([
            loadTiers(),
            dataManager.load<KeysFile>('keys'),
        ]);
        const tier = tiers[tierId];
        if (!tier) {
            return response.status(404).json({
                error: 'Not Found',
                message: `Tier '${tierId}' not found.`,
                timestamp: new Date().toISOString(),
            });
        }

        response.json({
            filePath: getTiersFilePath(),
            entry: buildTierResponse(tierId, tier, keys),
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load tier.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

adminRouter.put('/tiers/:tierId', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const tierId = String(request.params.tierId || '').trim();
        if (!tierId) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'tierId is required.',
                timestamp: new Date().toISOString(),
            });
        }

        let payload: any;
        try {
            payload = await request.json();
        } catch (parseError: any) {
            await logError({ message: 'Bad Request: Invalid JSON payload for tier upsert', parseError: parseError?.message }, request);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid JSON payload.',
                timestamp: new Date().toISOString(),
            });
        }

        const [tiers, keys] = await Promise.all([
            loadTiers(),
            dataManager.load<KeysFile>('keys'),
        ]);
        const existed = Boolean(tiers[tierId]);
        const nextTier = normalizeTierData(unwrapTierPayload(payload), tierId);
        const saved = await saveTiers({
            ...tiers,
            [tierId]: nextTier,
        });

        response.status(existed ? 200 : 201).json({
            message: existed ? 'Tier updated successfully.' : 'Tier created successfully.',
            filePath: getTiersFilePath(),
            entry: buildTierResponse(tierId, saved[tierId], keys),
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(400).json({
                error: 'Bad Request',
                message: error?.message || 'Failed to save tier.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

adminRouter.patch('/tiers/:tierId', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const tierId = String(request.params.tierId || '').trim();
        if (!tierId) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'tierId is required.',
                timestamp: new Date().toISOString(),
            });
        }

        let payload: any;
        try {
            payload = await request.json();
        } catch (parseError: any) {
            await logError({ message: 'Bad Request: Invalid JSON payload for tier patch', parseError: parseError?.message }, request);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid JSON payload.',
                timestamp: new Date().toISOString(),
            });
        }

        const [tiers, keys] = await Promise.all([
            loadTiers(),
            dataManager.load<KeysFile>('keys'),
        ]);
        const currentTier = tiers[tierId];
        if (!currentTier) {
            return response.status(404).json({
                error: 'Not Found',
                message: `Tier '${tierId}' not found.`,
                timestamp: new Date().toISOString(),
            });
        }

        const patchedTier = mergeTierPatch(currentTier, unwrapTierPayload(payload), tierId);
        const saved = await saveTiers({
            ...tiers,
            [tierId]: patchedTier,
        });

        response.json({
            message: 'Tier patched successfully.',
            filePath: getTiersFilePath(),
            entry: buildTierResponse(tierId, saved[tierId], keys),
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(400).json({
                error: 'Bad Request',
                message: error?.message || 'Failed to patch tier.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

adminRouter.delete('/tiers/:tierId', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const tierId = String(request.params.tierId || '').trim();
        if (!tierId) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'tierId is required.',
                timestamp: new Date().toISOString(),
            });
        }

        const tiers = await loadTiers();
        const currentTier = tiers[tierId];
        if (!currentTier) {
            return response.status(404).json({
                error: 'Not Found',
                message: `Tier '${tierId}' not found.`,
                timestamp: new Date().toISOString(),
            });
        }

        if (Object.keys(tiers).length <= 1) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Cannot delete the last remaining tier.',
                timestamp: new Date().toISOString(),
            });
        }

        const keys = await dataManager.load<KeysFile>('keys');
        const replacementTierRaw = typeof request.query?.replacementTier === 'string'
            ? request.query.replacementTier
            : typeof request.query?.replacement_tier === 'string'
                ? request.query.replacement_tier
                : '';
        const replacementTierId = replacementTierRaw ? normalizeTierId(tiers, replacementTierRaw) : null;
        if (replacementTierRaw && (!replacementTierId || replacementTierId === tierId)) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'replacementTier must reference a different existing tier.',
                timestamp: new Date().toISOString(),
            });
        }

        const usage = buildTierUsageSummary(keys, tierId);
        if (usage.assignedKeys > 0 && !replacementTierId) {
            return response.status(409).json({
                error: 'Conflict',
                message: `Tier '${tierId}' is still assigned to ${usage.assignedKeys} API key(s). Provide replacementTier to migrate them before deletion.`,
                usage,
                timestamp: new Date().toISOString(),
            });
        }

        let reassignedKeys = 0;
        if (replacementTierId) {
            await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
                for (const user of Object.values(currentKeys)) {
                    if (!user || user.tier !== tierId) continue;
                    user.tier = replacementTierId;
                    reassignedKeys += 1;
                }
                return currentKeys;
            });
        }

        const nextTiers = { ...tiers };
        delete nextTiers[tierId];
        const saved = await saveTiers(nextTiers);

        response.json({
            message: 'Tier deleted successfully.',
            filePath: getTiersFilePath(),
            deletedTierId: tierId,
            replacementTierId: replacementTierId ?? null,
            reassignedKeys,
            remainingTierCount: Object.keys(saved).length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to delete tier.',
                timestamp: new Date().toISOString(),
            });
        }
    }
});

// Endpoint to add or update a provider
adminRouter.post('/providers', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        let payload: any;
        try {
            payload = await request.json();
        } catch (parseError: any) {
            await logError({ message: 'Bad Request: Invalid JSON payload for add/update provider', parseError: parseError?.message }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid JSON payload.',
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        if (!validateAdminProviderPayload(payload)) {
            const validationErrors = formatAjvErrors(validateAdminProviderPayload.errors);
            await logError({ message: 'Bad Request: Provider payload validation failed', validationErrors }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid provider payload.',
                    details: validationErrors,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        const result = await addOrUpdateProvider(payload);

        const providerIdGuidance = [
            "Remember to use a descriptive 'providerId' that helps the system choose the correct handler:",
            "  - For OpenAI compatible: Use an ID like 'openai-yourdescriptivename'.",
            "  - For Gemini/Google: Use an ID like 'gemini-pro-api' or 'google-main'.",
            "  - For Anthropic: Use an ID like 'anthropic-claude-3'.",
            "  - Other IDs will default to an OpenAI-compatible handler if not specifically matched."
        ];

        response.json({
            message: `Provider ${result.id} processed successfully.`,
            provider: result,
            modelFetchStatus: result._modelFetchError ? `Warning: ${result._modelFetchError}` : 'Models fetched successfully (or no models applicable).',
            guidance: providerIdGuidance,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin add provider error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: error.message || 'Failed to add or update provider.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

// Endpoint to generate an API key for a user
adminRouter.post('/users/generate-key', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        let payload: any;
        try {
            payload = await request.json();
        } catch (parseError: any) {
            await logError({ message: 'Bad Request: Invalid JSON payload for generate-key', parseError: parseError?.message }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid JSON payload.',
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        if (!validateAdminGenerateKeyPayload(payload)) {
            const validationErrors = formatAjvErrors(validateAdminGenerateKeyPayload.errors);
            await logError({ message: 'Bad Request: generate-key payload validation failed', validationErrors }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid generate-key payload.',
                    details: validationErrors,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        const { userId, tier, role } = payload;
        const tiers = await loadTiers();
        const requestedTier = typeof tier === 'string' ? tier.trim() : '';
        if (requestedTier && !normalizeTierId(tiers, requestedTier)) {
            return response.status(400).json({
                error: 'Bad Request',
                message: `Unknown tier '${requestedTier}'.`,
                timestamp: new Date().toISOString()
            });
        }

        const apiKey = await generateUserApiKey(userId, role, requestedTier || undefined);
        response.json({
            message: `API key generated successfully for user ${userId}.`,
            userId,
            apiKey,
            tier: requestedTier || getFallbackUserTierId(tiers),
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin generate key error:', error);
        const referenceMessage = error.message.includes('already has an API key') || error.message.includes('Unknown tier')
            ? error.message
            : 'Failed to generate API key.';
        const statusCode = error.message.includes('already has an API key')
            ? 409
            : error.message.includes('Unknown tier')
                ? 400
                : 500;

        if (!response.completed) {
            response.status(statusCode).json({
                error: statusCode === 409 ? 'Conflict' : 'Internal Server Error',
                reference: referenceMessage,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// Endpoint to log provided API keys for auditing (accepts any input, no validation)
adminRouter.post('/keys', async (request: Request, response: Response) => {
    try {
        const ip = getRequestIp(request);
        const rateDecision = enforceInMemoryRateLimit(adminKeyIngestStore, ip, adminKeysRateLimits);
        if (!rateDecision.allowed) {
            const retryAfterSeconds = rateDecision.retryAfterSeconds ?? 1;
            response.setHeader('Retry-After', String(retryAfterSeconds));
            return response.status(429).json({
                error: 'Rate limit exceeded',
                retry_after_seconds: retryAfterSeconds,
                timestamp: new Date().toISOString()
            });
        }

        const contentLengthHeader = request.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = Number(contentLengthHeader);
            if (Number.isFinite(contentLength) && contentLength > adminKeysMaxBodyBytes) {
                return response.status(413).json({
                    error: 'Payload too large',
                    message: `Request body exceeds ${adminKeysMaxBodyBytes} bytes.`,
                    timestamp: new Date().toISOString()
                });
            }
        }

        const contentType = request.headers['content-type'];
        if (contentType && typeof contentType === 'string' && !contentType.toLowerCase().includes('application/json')) {
            return response.status(415).json({
                error: 'Unsupported Media Type',
                message: 'Content-Type must be application/json.',
                timestamp: new Date().toISOString()
            });
        }

        let body: any = null;
        let parsed = false;
        try {
            body = await request.json();
            parsed = true;
        } catch (parseError: any) {
            await logError({ message: 'Invalid JSON payload received at /admin/keys', parseError: parseError?.message }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid JSON payload.',
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        const estimatedSize = Buffer.byteLength(JSON.stringify(body), 'utf8');
        if (estimatedSize > adminKeysMaxBodyBytes) {
            return response.status(413).json({
                error: 'Payload too large',
                message: `Request body exceeds ${adminKeysMaxBodyBytes} bytes.`,
                timestamp: new Date().toISOString()
            });
        }

        const key = parsed && body && typeof body === 'object' && typeof body.key === 'string' ? body.key.trim() : '';
        const provider = parsed && body && typeof body === 'object' && typeof body.provider === 'string'
            ? body.provider.trim().toLowerCase()
            : '';
        const tierValue = parsed && body && typeof body === 'object' ? body.tier : undefined;
        const normalized = {
            key,
            provider,
            tier: typeof tierValue === 'undefined' ? null : tierValue,
        };

        if (!validateAdminKeyIngestPayload(normalized)) {
            const validationErrors = formatAjvErrors(validateAdminKeyIngestPayload.errors);
            await logError({ message: 'Bad Request: Admin key ingest payload validation failed', validationErrors }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'Invalid key payload.',
                    details: validationErrors,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        if (/\s/.test(normalized.key)) {
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Key must not contain whitespace.',
                timestamp: new Date().toISOString()
            });
        }

        if (adminKeysAllowedProviders && !adminKeysAllowedProviders.has(normalized.provider)) {
            return response.status(403).json({
                error: 'Forbidden',
                message: 'Provider is not allowed.',
                timestamp: new Date().toISOString()
            });
        }

        const logEntry = {
            key: normalized.key,
            provider: normalized.provider,
            tier: normalized.tier ?? null,
            raw: normalized,
            userId: request.userId ?? null,
            receivedAt: new Date().toISOString(),
            sourceIp: ip,
        };

        await appendAdminKeyLog(logEntry);
        notifyAdminKeyReceived();

        response.status(201).json({
            message: 'Key logged successfully.',
            timestamp: logEntry.receivedAt
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin log key error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to log provided key.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

// Endpoint to fetch logged API keys for review
adminRouter.get('/keys', adminOnlyMiddleware, async (_request: Request, response: Response) => {
    try {
        const { entries, total } = await readAdminKeyLog();
        response.json({
            entries,
            count: entries.length,
            total,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, _request as any);
        console.error('Admin get keys error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to read logged keys.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

// --- API Key Management (admin only) ---

adminRouter.get('/api-keys', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const [keys, tiers] = await Promise.all([
            dataManager.load<KeysFile>('keys'),
            loadTiers(),
        ]);
        const roleFilter = typeof request.query?.role === 'string' ? request.query.role : null;
        const tierFilter = typeof request.query?.tier === 'string' ? request.query.tier : null;
        const userIdFilter = typeof request.query?.userId === 'string' ? request.query.userId : null;

        const entries = Object.entries(keys)
            .filter(([, user]) => !roleFilter || user.role === roleFilter)
            .filter(([, user]) => !tierFilter || user.tier === tierFilter)
            .filter(([, user]) => !userIdFilter || user.userId === userIdFilter)
            .map(([apiKey, user]) => summarizeApiKey(apiKey, user, tiers));

        response.json({
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin list api-keys error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to list API keys.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/api-keys/revoke', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        if (!validateAdminApiKeySelector(payload)) {
            const validationErrors = formatAjvErrors(validateAdminApiKeySelector.errors);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid selector payload.',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }

        const beforeKeys = await dataManager.load<KeysFile>('keys');
        const resolved = resolveApiKeySelector(beforeKeys, payload);
        if (!resolved) {
            return response.status(404).json({
                error: 'Not Found',
                message: 'API key not found.',
                timestamp: new Date().toISOString()
            });
        }

        await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            delete currentKeys[resolved.apiKey];
            return currentKeys;
        });

        const tiers = await loadTiers();
        response.json({
            message: 'API key revoked.',
            entry: summarizeApiKey(resolved.apiKey, resolved.user, tiers),
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin revoke api-key error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to revoke API key.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/api-keys/reset-usage', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        if (!validateAdminApiKeySelector(payload)) {
            const validationErrors = formatAjvErrors(validateAdminApiKeySelector.errors);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid selector payload.',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }

        const beforeKeys = await dataManager.load<KeysFile>('keys');
        const resolved = resolveApiKeySelector(beforeKeys, payload);
        if (!resolved) {
            return response.status(404).json({
                error: 'Not Found',
                message: 'API key not found.',
                timestamp: new Date().toISOString()
            });
        }

        const updatedUser = resetUserUsageAccounting(resolved.user, new Date().toISOString());
        await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            currentKeys[resolved.apiKey] = updatedUser;
            return currentKeys;
        });

        const tiers = await loadTiers();
        response.json({
            message: 'Usage counters reset.',
            entry: summarizeApiKey(resolved.apiKey, updatedUser, tiers),
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin reset usage error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to reset usage.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/api-keys/settle-billing', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        if (!validateAdminApiKeySelector(payload)) {
            const validationErrors = formatAjvErrors(validateAdminApiKeySelector.errors);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid selector payload.',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }

        const beforeKeys = await dataManager.load<KeysFile>('keys');
        const resolved = resolveApiKeySelector(beforeKeys, payload);
        if (!resolved) {
            return response.status(404).json({
                error: 'Not Found',
                message: 'API key not found.',
                timestamp: new Date().toISOString()
            });
        }

        const liveTiers = await loadTiers();
        const settledAt = new Date().toISOString();
        const beforeUsage = deriveKeyUsageSnapshot(resolved.user, liveTiers[resolved.user.tier]);
        const updatedUser = settleUserBillingPeriod(resolved.user, settledAt);

        await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            currentKeys[resolved.apiKey] = updatedUser;
            return currentKeys;
        });

        response.json({
            message: 'Billing period settled.',
            settledAt,
            settled: {
                tokenUsage: beforeUsage.billingPeriodTokenUsage,
                requestCount: beforeUsage.billingPeriodRequestCount,
                estimatedCost: beforeUsage.billingPeriodEstimatedCost,
            },
            entry: summarizeApiKey(resolved.apiKey, updatedUser, liveTiers),
            timestamp: settledAt,
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin settle billing error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to settle billing period.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/api-keys/update', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        if (!validateAdminApiKeyUpdatePayload(payload)) {
            const validationErrors = formatAjvErrors(validateAdminApiKeyUpdatePayload.errors);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid update payload.',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }

        const tiers = await loadTiers();
        if (payload.tier && !normalizeTierId(tiers, payload.tier)) {
            return response.status(400).json({
                error: 'Bad Request',
                message: `Unknown tier '${payload.tier}'.`,
                timestamp: new Date().toISOString()
            });
        }

        const beforeKeys = await dataManager.load<KeysFile>('keys');
        const resolved = resolveApiKeySelector(beforeKeys, payload);
        if (!resolved) {
            return response.status(404).json({
                error: 'Not Found',
                message: 'API key not found.',
                timestamp: new Date().toISOString()
            });
        }

        const updatedUser = { ...resolved.user };
        if (payload.role) updatedUser.role = payload.role;
        if (payload.tier) updatedUser.tier = payload.tier;

        await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            currentKeys[resolved.apiKey] = updatedUser;
            return currentKeys;
        });

        response.json({
            message: 'API key updated.',
            entry: summarizeApiKey(resolved.apiKey, updatedUser, tiers),
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin update api-key error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to update API key.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/api-keys/rotate', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        if (!validateAdminApiKeyRotatePayload(payload)) {
            const validationErrors = formatAjvErrors(validateAdminApiKeyRotatePayload.errors);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'Invalid rotate payload.',
                details: validationErrors,
                timestamp: new Date().toISOString()
            });
        }

        const tiers = await loadTiers();
        if (payload.tier && !normalizeTierId(tiers, payload.tier)) {
            return response.status(400).json({
                error: 'Bad Request',
                message: `Unknown tier '${payload.tier}'.`,
                timestamp: new Date().toISOString()
            });
        }

        const beforeKeys = await dataManager.load<KeysFile>('keys');
        const resolved = resolveApiKeySelector(beforeKeys, payload);
        if (!resolved) {
            return response.status(404).json({
                error: 'Not Found',
                message: 'API key not found.',
                timestamp: new Date().toISOString()
            });
        }

        const updatedUser = { ...resolved.user };
        if (payload.role) updatedUser.role = payload.role;
        if (payload.tier) updatedUser.tier = payload.tier;
        updatedUser.tokenUsage = typeof updatedUser.tokenUsage === 'number' ? updatedUser.tokenUsage : 0;
        updatedUser.requestCount = typeof updatedUser.requestCount === 'number' ? updatedUser.requestCount : 0;

        const afterKeys = await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            let newKey = crypto.randomBytes(32).toString('hex');
            while (currentKeys[newKey]) {
                newKey = crypto.randomBytes(32).toString('hex');
            }
            delete currentKeys[resolved.apiKey];
            currentKeys[newKey] = updatedUser;
            return currentKeys;
        });

        const newKey = Object.keys(afterKeys).find((key) => !beforeKeys[key] && afterKeys[key]?.userId === updatedUser.userId);
        if (!newKey) {
            return response.status(409).json({
                error: 'Conflict',
                message: 'Failed to rotate API key.',
                timestamp: new Date().toISOString()
            });
        }

        response.json({
            message: 'API key rotated.',
            entry: summarizeApiKey(newKey, updatedUser, tiers),
            oldKeyMasked: redactToken(resolved.apiKey),
            newKey,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin rotate api-key error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to rotate API key.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

// --- Metrics (admin only) ---

async function getErrorLogStats(): Promise<{ totalLines: number; lastTimestamp: string | null; fileBytes: number; truncated: boolean }> {
    const errorLogPaths = [
        path.join(logDirectory, 'api-errors.jsonl'),
        path.join(logDirectory, 'api-error.jsonl'),
    ];
    const existingPaths: string[] = [];
    let fileBytes = 0;
    for (const errorLogPath of errorLogPaths) {
        try {
            const stat = await fs.promises.stat(errorLogPath);
            fileBytes += stat.size;
            existingPaths.push(errorLogPath);
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                throw err;
            }
        }
    }
    if (existingPaths.length === 0) {
        return { totalLines: 0, lastTimestamp: null, fileBytes: 0, truncated: false };
    }

    const parsedMaxLines = parseInt(process.env.ADMIN_METRICS_MAX_ERROR_LINES || '200000', 10);
    const maxLines = Number.isFinite(parsedMaxLines) ? Math.max(1, parsedMaxLines) : 200000;
    let totalLines = 0;
    let lastTimestamp: string | null = null;
    let truncated = false;

    for (const errorLogPath of existingPaths) {
        const stream = fs.createReadStream(errorLogPath, { encoding: 'utf8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            totalLines += 1;
            if (totalLines > maxLines) {
                truncated = true;
                break;
            }
            try {
                const entry = JSON.parse(trimmed);
                if (entry?.timestamp) lastTimestamp = entry.timestamp;
            } catch {
                // ignore parse errors
            }
        }
        if (truncated) {
            break;
        }
    }

    return { totalLines, lastTimestamp, fileBytes, truncated };
}

function buildQueueMetricsPayload() {
    const apiQueues = getOpenAiAdmissionQueueSnapshots().map((entry) => ({
        category: 'api',
        ...entry,
    }));
    const providerStatsQueues = getProviderStatsQueueSnapshots().map((entry, index) => ({
        category: 'provider-stats',
        worker: index + 1,
        ...entry,
    }));
    const entries: Record<string, unknown>[] = [...apiQueues, ...providerStatsQueues];
    const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const busiestEntry = entries.reduce<Record<string, unknown> | null>((current, entry) => {
        if (!current) return entry;
        const currentLoad = asNumber(current['pending']) + asNumber(current['inFlight']);
        const nextLoad = asNumber(entry['pending']) + asNumber(entry['inFlight']);
        return nextLoad > currentLoad ? entry : current;
    }, null);

    return {
        entries,
        count: entries.length,
        summary: {
            totalQueues: entries.length,
            totalPending: entries.reduce((sum, entry) => sum + asNumber(entry['pending']), 0),
            totalInFlight: entries.reduce((sum, entry) => sum + asNumber(entry['inFlight']), 0),
            totalOverloadCount: entries.reduce((sum, entry) => sum + asNumber(entry['overloadCount']), 0),
            overloadedQueues: entries.filter((entry) => asNumber(entry['overloadCount']) > 0).length,
            busiestQueue: busiestEntry ? {
                label: busiestEntry['label'],
                category: busiestEntry['category'],
                pending: asNumber(busiestEntry['pending']),
                inFlight: asNumber(busiestEntry['inFlight']),
                overloadCount: asNumber(busiestEntry['overloadCount']),
            } : null,
        },
        timestamp: new Date().toISOString(),
    };
}

adminRouter.get('/metrics/summary', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const [providers, models, keys, errorStats, tiers, fleetInstances] = await Promise.all([
            dataManager.load<LoadedProviders>('providers'),
            dataManager.load<ModelsFileStructure>('models'),
            dataManager.load<KeysFile>('keys'),
            getErrorLogStats(),
            loadTiers(),
            getFleetInstances(),
        ]);
        const queueMetrics = buildQueueMetricsPayload();

        const providerTotal = providers.length;
        const providerDisabled = providers.filter((p) => p.disabled).length;
        const providerEnabled = providerTotal - providerDisabled;

        const modelTotal = Array.isArray(models?.data) ? models.data.length : 0;
        const providersPerModel: Record<string, number> = {};
        if (Array.isArray(models?.data)) {
            for (const model of models.data) {
                const count = typeof model.providers === 'number' ? model.providers : 0;
                providersPerModel[String(count)] = (providersPerModel[String(count)] || 0) + 1;
            }
        }

        const keysByRole: Record<string, number> = {};
        const keysByTier: Record<string, number> = {};
        const keyUsageTotals = {
            totalTokenUsage: 0,
            paidTokenUsage: 0,
            billingPeriodTokenUsage: 0,
            totalRequestCount: 0,
            paidRequestCount: 0,
            billingPeriodRequestCount: 0,
            totalEstimatedCost: 0,
            paidEstimatedCost: 0,
            billingPeriodEstimatedCost: 0,
        };
        for (const user of Object.values(keys)) {
            keysByRole[user.role] = (keysByRole[user.role] || 0) + 1;
            keysByTier[user.tier] = (keysByTier[user.tier] || 0) + 1;
            const usage = deriveKeyUsageSnapshot(user, tiers[user.tier]);
            keyUsageTotals.totalTokenUsage += usage.totalTokenUsage;
            keyUsageTotals.paidTokenUsage += usage.paidTokenUsage;
            keyUsageTotals.billingPeriodTokenUsage += usage.billingPeriodTokenUsage;
            keyUsageTotals.totalRequestCount += usage.totalRequestCount;
            keyUsageTotals.paidRequestCount += usage.paidRequestCount;
            keyUsageTotals.billingPeriodRequestCount += usage.billingPeriodRequestCount;
            keyUsageTotals.totalEstimatedCost += usage.totalEstimatedCost;
            keyUsageTotals.paidEstimatedCost += usage.paidEstimatedCost;
            keyUsageTotals.billingPeriodEstimatedCost += usage.billingPeriodEstimatedCost;
        }

        response.json({
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            providers: {
                total: providerTotal,
                enabled: providerEnabled,
                disabled: providerDisabled,
            },
            models: {
                total: modelTotal,
                providersPerModel,
            },
            keys: {
                total: Object.keys(keys).length,
                byRole: keysByRole,
                byTier: keysByTier,
                usage: {
                    total_token_usage: keyUsageTotals.totalTokenUsage,
                    paid_token_usage: keyUsageTotals.paidTokenUsage,
                    billing_period_token_usage: keyUsageTotals.billingPeriodTokenUsage,
                    total_request_count: keyUsageTotals.totalRequestCount,
                    paid_request_count: keyUsageTotals.paidRequestCount,
                    billing_period_request_count: keyUsageTotals.billingPeriodRequestCount,
                    total_estimated_cost: Math.round(keyUsageTotals.totalEstimatedCost * 1_000_000) / 1_000_000,
                    paid_estimated_cost: Math.round(keyUsageTotals.paidEstimatedCost * 1_000_000) / 1_000_000,
                    billing_period_estimated_cost: Math.round(keyUsageTotals.billingPeriodEstimatedCost * 1_000_000) / 1_000_000,
                },
            },
            queues: queueMetrics.summary,
            fleet: {
                total: fleetInstances.length,
                ready: fleetInstances.filter((entry) => entry.state === 'ready').length,
                draining: fleetInstances.filter((entry) => entry.state === 'draining').length,
                starting: fleetInstances.filter((entry) => entry.state === 'starting').length,
            },
            errorLog: errorStats,
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin metrics summary error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load metrics summary.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.get('/metrics/fleet', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const entries = await getFleetInstances();
        response.json({
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin metrics fleet error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load fleet metrics.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.get('/metrics/queues', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        response.json(buildQueueMetricsPayload());
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin metrics queues error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load queue metrics.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.get('/metrics/providers', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const providers = await dataManager.load<LoadedProviders>('providers');
        const entries = providers.map((provider) => ({
            id: provider.id,
            disabled: provider.disabled,
            modelCount: provider.models ? Object.keys(provider.models).length : 0,
            errors: provider.errors,
            avg_response_time: provider.avg_response_time,
            avg_provider_latency: provider.avg_provider_latency,
            provider_score: provider.provider_score,
        }));

        response.json({
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin metrics providers error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load provider metrics.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.get('/metrics/models', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const models = await dataManager.load<ModelsFileStructure>('models');
        const entries = Array.isArray(models?.data)
            ? models.data.map((model) => ({
                id: model.id,
                providers: model.providers,
                throughput: model.throughput ?? null,
                capabilities: model.capabilities ?? [],
            }))
            : [];

        response.json({
            entries,
            count: entries.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin metrics models error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load model metrics.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

adminRouter.post('/models/refresh-provider-counts', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        await refreshProviderCountsInModelsFile();
        response.status(200).json({
            message: 'Successfully refreshed provider counts in models.json.',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        await logError(error, request);
        console.error('Admin refresh provider counts error:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to refresh provider counts.',
                timestamp: new Date().toISOString()
            });
        }
    }
});

export { adminRouter };
