import HyperExpress from 'hyper-express';

export const serveModelsJson = (server: HyperExpress.Server) => {
    server.get('/models', (request, response) => {
        const filePath = './dev/models.json';
        response.sendFile(filePath);
    });
};