import dotenv from 'dotenv';
import { Server } from 'hyper-express';
import axios from 'axios';

dotenv.config();
const apiKey = process.env.OPENAI_API_KEY || '';

const server = new Server();
const port = 3001;

server.post('/openai', async (request, response) => {
	const endpoint = `https://api.openai.com/v1/chat/completions`;

	const body = await request.json();
	const params = {
		model: 'gpt-4-turbo',
		messages: [{ role: 'user', content: body.message }],
		temperature: 0.7
	};

	const startTime = Date.now();

	try {
		console.log('Params:', params);
		const axiosResponse = await axios.post(endpoint, params, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			}
		});

		const endTime = Date.now();
		const totalLatency = endTime - startTime;

		response.json({
			...axiosResponse.data,
			latency: totalLatency
		});
	} catch (error) {
		console.error('Error in OpenAI API call:', error);
		response.status(500).json('Error in OpenAI API call');
	}
});

server.listen(port).then(() => {
	console.log(`Server running at http://localhost:${port}`);
});
