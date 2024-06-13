import { Server } from 'hyper-express';
import axios from 'axios';

const server = new Server();
const port = 3000;

let responseData: null = null;

server.post('/openai', (request, response) => {
	const body = request.body;

	if (!body.message) {
		return response
			.status(400)
			.json({ error: 'Missing message in request body' });
	}
});

server.listen(port).then(() => {
	console.log(`Server running at http://localhost:${port}`);
});

module.exports = {
	getResponseData: () => responseData
};
