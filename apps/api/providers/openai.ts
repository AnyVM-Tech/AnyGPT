import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();
const apiKey = process.env.OPENAI_API_KEY || '';

interface IAIProvider {
	sendMessage(message: string): Promise<{response: string, latency: number}>;
  }
export class OpenAI implements IAIProvider {
    private message: string;

    constructor(message: string) {
        this.message = message;
    }
	async sendMessage(message: string): Promise<{ response: string; latency: number; }> {
		const startTime = performance.now();
		const url = `https://api.openai.com/v1/chat/completions`;
		const headers = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
		};
	
		const data = message;
	
		try {
			const response = await axios.post(url, data, { headers });
			const endTime = performance.now();

			console.log("Full response:", JSON.stringify(response.data, null, 2));
if (response.data.choices && response.data.choices.length > 0 && response.data.choices[0].message && response.data.choices[0].message.content) {
    return {
        response: response.data.choices[0].message.content,
        latency: endTime - startTime
    };
} else {
    console.warn("Expected data not found in response:", JSON.stringify(response.data, null, 2));
    return { response: 'Data not found', latency: endTime - startTime };
}
		} catch (error) {
			console.error('Error sending message to OpenAI:', error);
			throw error;
		}
	}
}