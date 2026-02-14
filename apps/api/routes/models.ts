import HyperExpress from '../lib/uws-compat.js';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';
import { dataManager, ModelsFileStructure } from '../modules/dataManager.js'; // For serving the main models.json
import { logError } from '../modules/errorLogger.js'; // Changed import

const modelsRouter = new HyperExpress.Router();

// Debug route to inspect IP and forwarded headers
modelsRouter.get('/debug/ip', (request, response) => {
    response.json({
        ip: (request as any).ip,
        xForwardedFor: request.headers['x-forwarded-for'],
        xRealIp: request.headers['x-real-ip'],
        headers: request.headers,
    });
});

async function sendModelsResponse(request: any, response: any) {
    try {
        const modelsData = await dataManager.load<ModelsFileStructure>('models');
        response.json(modelsData);
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
modelsRouter.get('/v1/models', sendModelsResponse);

// OpenAI-compatible aliases so clients can hit chat completion model discovery
modelsRouter.get('/v1/chat/completions/models', sendModelsResponse);
modelsRouter.get('/v1/chat/completion/models', sendModelsResponse);

// Route to trigger the refresh of provider counts in models.json
modelsRouter.post('/admin/models/refresh-provider-counts', async (request, response) => {
    try {
        await refreshProviderCountsInModelsFile();
        response.status(200).json({ message: 'Successfully refreshed provider counts in models.json.', timestamp: new Date().toISOString() });
    } catch (error) {
        await logError(error, request); // Renamed and added await
        console.error('Error triggering provider count refresh:', error); // Keep console log
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to refresh provider counts.', // More specific internal reference
                timestamp: new Date().toISOString()
            });
        } else {
            console.warn('[POST /admin/models/refresh-provider-counts] Response already completed, could not send 500 JSON error.');
        }
    }
});

export { modelsRouter };