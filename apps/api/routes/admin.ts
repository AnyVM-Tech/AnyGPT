import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import fs from 'fs';
import path from 'path';
import { addOrUpdateProvider } from '../server/addProvider.js';
import { generateUserApiKey } from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js';
import { notifyAdminKeyReceived } from '../modules/adminKeySync.js';

const adminRouter = new HyperExpress.Router();
const adminKeysLogPath = path.resolve('logs/admin-keys.json');

async function appendAdminKeyLog(entry: Record<string, any>) {
    await fs.promises.mkdir(path.dirname(adminKeysLogPath), { recursive: true });

    let existing: any[] = [];
    try {
        const raw = await fs.promises.readFile(adminKeysLogPath, 'utf8');
        existing = JSON.parse(raw);
        if (!Array.isArray(existing)) existing = [];
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.warn(`[admin/keys] Failed to read existing log, reinitializing. Reason: ${error.message}`);
        }
    }

    existing.push(entry);
    await fs.promises.writeFile(adminKeysLogPath, JSON.stringify(existing, null, 2), 'utf8');
}

// Admin Authentication Middleware (apply only to sensitive routes)
const adminOnlyMiddleware = (request: Request, response: Response, next: () => void) => {
    if (request.userRole !== 'admin') {
        logError({ message: 'Forbidden: Admin access required.', attemptedPath: request.url, userRole: request.userRole, apiKey: request.apiKey }, request).catch(e => console.error('Failed background log:', e));
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
        const payload = await request.json();
        if (!payload.providerId || !payload.providerBaseUrl) {
            await logError({ message: 'Bad Request: Missing providerId or providerBaseUrl for add/update provider' }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'providerId and providerBaseUrl are required.',
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
        const { userId, tier, role } = await request.json();
        if (!userId || typeof userId !== 'string') {
            await logError({ message: 'Bad Request: userId is required for generating API key' }, request);
            if (!response.completed) {
                return response.status(400).json({
                    error: 'Bad Request',
                    message: 'userId (string) is required.',
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }
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
        let body: any = null;
        let parsed = false;
        try {
            body = await request.json();
            parsed = true;
        } catch (parseError: any) {
            // Fallback to raw text if JSON parse fails
            body = { raw: await request.text() };
            await logError({ message: 'Non-JSON payload received at /admin/keys', parseError: parseError?.message }, request);
        }

        const logEntry = {
            key: parsed && body && typeof body === 'object' ? body.key ?? null : null,
            provider: parsed && body && typeof body === 'object' ? body.provider ?? null : null,
            tier: parsed && body && typeof body === 'object' ? (typeof body.tier === 'undefined' ? null : body.tier) : null,
            raw: body,
            userId: request.userId ?? null,
            receivedAt: new Date().toISOString(),
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
adminRouter.get('/keys', async (_request: Request, response: Response) => {
    try {
        let entries: any[] = [];
        try {
            const raw = await fs.promises.readFile(adminKeysLogPath, 'utf8');
            entries = JSON.parse(raw);
            if (!Array.isArray(entries)) entries = [];
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.warn(`[admin/keys] Failed to read log for GET. Reason: ${error.message}`);
            }
        }

        response.json({ entries, count: entries.length, timestamp: new Date().toISOString() });
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

export { adminRouter };
