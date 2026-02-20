import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'node:readline';
import crypto from 'crypto';
import { addOrUpdateProvider } from '../server/addProvider.js';
import { generateUserApiKey } from '../modules/userData.js';
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
import tiersData from '../tiers.json' with { type: 'json' };

const adminRouter = new HyperExpress.Router();
const adminKeysLogPath = path.resolve('logs/admin-keys.jsonl');
const legacyAdminKeysLogPath = path.resolve('logs/admin-keys.json');
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

const tiers = tiersData as Record<string, { rps: number; rpm: number; rpd: number; max_tokens: number | null }>;

function normalizeTier(tier?: string): string | null {
    if (!tier) return null;
    return tiers[tier] ? tier : null;
}

function summarizeApiKey(apiKey: string, user: { userId: string; role: string; tier: string; tokenUsage: number; requestCount: number }) {
    return {
        apiKeyMasked: redactToken(apiKey),
        apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12),
        userId: user.userId,
        role: user.role,
        tier: user.tier,
        tokenUsage: user.tokenUsage,
        requestCount: user.requestCount,
    };
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
    next();
};

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
        const apiKey = await generateUserApiKey(userId, role, tier);
        response.json({
            message: `API key generated successfully for user ${userId}.`,
            userId,
            apiKey,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        await logError(error, request);
        console.error('Admin generate key error:', error);
        const referenceMessage = error.message.includes('already has an API key') ? error.message : 'Failed to generate API key.';
        const statusCode = error.message.includes('already has an API key') ? 409 : 500;

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
        const keys = await dataManager.load<KeysFile>('keys');
        const roleFilter = typeof request.query?.role === 'string' ? request.query.role : null;
        const tierFilter = typeof request.query?.tier === 'string' ? request.query.tier : null;
        const userIdFilter = typeof request.query?.userId === 'string' ? request.query.userId : null;

        const entries = Object.entries(keys)
            .filter(([, user]) => !roleFilter || user.role === roleFilter)
            .filter(([, user]) => !tierFilter || user.tier === tierFilter)
            .filter(([, user]) => !userIdFilter || user.userId === userIdFilter)
            .map(([apiKey, user]) => summarizeApiKey(apiKey, user));

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

        response.json({
            message: 'API key revoked.',
            entry: summarizeApiKey(resolved.apiKey, resolved.user),
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

        const updatedUser = { ...resolved.user, tokenUsage: 0, requestCount: 0 };
        await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
            if (!currentKeys[resolved.apiKey]) return currentKeys;
            currentKeys[resolved.apiKey] = updatedUser;
            return currentKeys;
        });

        response.json({
            message: 'Usage counters reset.',
            entry: summarizeApiKey(resolved.apiKey, updatedUser),
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

        if (payload.tier && !normalizeTier(payload.tier)) {
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
            entry: summarizeApiKey(resolved.apiKey, updatedUser),
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

        if (payload.tier && !normalizeTier(payload.tier)) {
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
            entry: summarizeApiKey(newKey, updatedUser),
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
    const errorLogPath = path.resolve('logs/api-error.jsonl');
    let fileBytes = 0;
    try {
        const stat = await fs.promises.stat(errorLogPath);
        fileBytes = stat.size;
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            return { totalLines: 0, lastTimestamp: null, fileBytes: 0, truncated: false };
        }
        throw err;
    }

    const parsedMaxLines = parseInt(process.env.ADMIN_METRICS_MAX_ERROR_LINES || '200000', 10);
    const maxLines = Number.isFinite(parsedMaxLines) ? Math.max(1, parsedMaxLines) : 200000;
    let totalLines = 0;
    let lastTimestamp: string | null = null;
    let truncated = false;

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

    return { totalLines, lastTimestamp, fileBytes, truncated };
}

adminRouter.get('/metrics/summary', adminOnlyMiddleware, async (request: Request, response: Response) => {
    try {
        const [providers, models, keys, errorStats] = await Promise.all([
            dataManager.load<LoadedProviders>('providers'),
            dataManager.load<ModelsFileStructure>('models'),
            dataManager.load<KeysFile>('keys'),
            getErrorLogStats(),
        ]);

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
        for (const user of Object.values(keys)) {
            keysByRole[user.role] = (keysByRole[user.role] || 0) + 1;
            keysByTier[user.tier] = (keysByTier[user.tier] || 0) + 1;
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

export { adminRouter };
