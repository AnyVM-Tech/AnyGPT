import HyperExpress, { Request, Response } from 'hyper-express';
import { addOrUpdateProvider } from '../server/addProvider'; // Path to the refactored function
import { generateUserApiKey } from '../modules/userData'; // For generating API keys
import { logErrorToFile } from '../modules/errorLogger';

const adminRouter = new HyperExpress.Router();

// Admin Authentication Middleware
// This middleware assumes that a general authentication middleware has already run
// and populated request.userRole and request.apiKey.
// You might need to ensure such a middleware is applied to the /api/admin base path in server.ts
const adminOnlyMiddleware = (request: Request, response: Response, next: () => void) => {
    // Ensure userRole is populated by a preceding authentication middleware
    if (request.userRole !== 'admin') {
        logErrorToFile({ message: 'Forbidden: Admin access required.', attemptedPath: request.url, userRole: request.userRole, apiKey: request.apiKey }, request);
        return response.status(403).json({
            error: 'Forbidden',
            message: 'Admin access required.',
            timestamp: new Date().toISOString()
        });
    }
    next();
};

// Apply admin-only middleware to all routes in this router
adminRouter.use(adminOnlyMiddleware);

// Endpoint to add or update a provider
adminRouter.post('/providers', async (request: Request, response: Response) => {
    try {
        const payload = await request.json();
        // Basic validation, more can be added
        if (!payload.providerId || !payload.providerBaseUrl) {
            logErrorToFile({ message: 'Bad Request: Missing providerId or providerBaseUrl for add/update provider'}, request);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'providerId and providerBaseUrl are required.',
                timestamp: new Date().toISOString()
            });
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
        logErrorToFile(error, request);
        console.error('Admin add provider error:', error);
        response.status(500).json({
            error: 'Internal Server Error',
            reference: error.message || 'Failed to add or update provider.',
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint to generate an API key for a user
adminRouter.post('/users/generate-key', async (request: Request, response: Response) => {
    try {
        const { userId, tier, role } = await request.json(); // Assuming tier and role might also be provided
        if (!userId || typeof userId !== 'string') {
            logErrorToFile({ message: 'Bad Request: userId is required for generating API key' }, request);
            return response.status(400).json({
                error: 'Bad Request',
                message: 'userId (string) is required.',
                timestamp: new Date().toISOString()
            });
        }
        // Call the existing async function from userData module
        // Adjust parameters for generateUserApiKey if it needs more than just userId (e.g., tier, role for new users)
        const apiKey = await generateUserApiKey(userId, role, tier); 
        response.json({ 
            message: `API key generated successfully for user ${userId}.`,
            userId: userId,
            apiKey: apiKey, 
            timestamp: new Date().toISOString() 
        });
    } catch (error: any) {
        logErrorToFile(error, request);
        console.error('Admin generate key error:', error);
        const referenceMessage = error.message.includes('already has an API key') ? error.message : 'Failed to generate API key.';
        const statusCode = error.message.includes('already has an API key') ? 409 : 500;

        response.status(statusCode).json({
            error: statusCode === 409 ? 'Conflict' : 'Internal Server Error',
            reference: referenceMessage,
            timestamp: new Date().toISOString()
        });
    }
});

export { adminRouter }; 