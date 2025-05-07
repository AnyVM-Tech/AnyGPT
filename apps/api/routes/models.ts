import HyperExpress from 'hyper-express';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater';
import { dataManager } from '../modules/dataManager'; // For serving the main models.json
import { logError } from '../modules/errorLogger'; // Changed import
import path from 'path';

const modelsRouter = new HyperExpress.Router();

// Route to serve the main models.json (apps/api/models.json)
modelsRouter.get('/v1/models', async (request, response) => {
    try {
        const filePath = path.resolve(process.cwd(), 'apps/api/models.json'); 
        // Before sending, ensure the content is parsed if readFile returns a string
        const fileContentString = await dataManager.readFile(filePath);
        const jsonData = JSON.parse(fileContentString);
        response.json(jsonData);
    } catch (error) {
        await logError(error, request); // Renamed and added await
        console.error('Error serving models.json:', error); // Keep console log
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load models data.', // More specific internal reference, not the raw error.message
                timestamp: new Date().toISOString()
            });
        } else {
             console.warn('[GET /models] Response already completed, could not send 500 JSON error.');
        }
    }
});

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