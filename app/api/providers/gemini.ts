import dotenv from 'dotenv';
import { Server } from 'hyper-express';
import {
	GoogleGenerativeAI,
	HarmCategory,
	HarmBlockThreshold
} from '@google/generative-ai';

dotenv.config();
const apiKey = process.env.GEMINI_API_KEY || '';

const server = new Server();
const port = 3001;

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
	model: 'gemini-1.5-pro'
});

const generationConfig = {
	temperature: 1,
	topP: 0.95,
	topK: 64,
	maxOutputTokens: 8192,
	responseMimeType: 'text/plain'
};

const safetySettings = [
	{
		category: HarmCategory.HARM_CATEGORY_HARASSMENT,
		threshold: HarmBlockThreshold.BLOCK_NONE
	},
	{
		category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
		threshold: HarmBlockThreshold.BLOCK_NONE
	},
	{
		category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
		threshold: HarmBlockThreshold.BLOCK_NONE
	},
	{
		category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
		threshold: HarmBlockThreshold.BLOCK_NONE
	}
];

server.post('/gemini', async (request, response) => {
	const startTime = Date.now();

	try {
		const chatSession = model.startChat({
			generationConfig,
			safetySettings,
			history: []
		});

		const result = await chatSession.sendMessage(
			(await request.json()).message
		);
		console.log('Result:', result);

		const endTime = Date.now();
		const totalLatency = endTime - startTime;

		response.json({
			response: result.response.text(),
			latency: totalLatency
		});
	} catch (error) {
		console.error('Error in Gemini API call:', error);
		response.status(500).json('Error in Gemini API call');
	}
});

server.listen(port).then(() => {
	console.log(`Server running at http://localhost:${port}`);
});
