import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();
const apiKey = process.env.OPENAI_API_KEY || '';
import { updateModelLatency } from './handler';
interface IAIProvider {
    sendMessage(message: string): Promise<{response: string, latency: number}>;
    isBusy(): boolean;
    getLatency(): number;
}


interface IMessage {
    content: string;
    model: {
        id: string;
    };
}

export class OpenAI implements IAIProvider {
    private busy: boolean = false;
    private lastLatency: number = 0;
    private apiKey: string; 

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    isBusy(): boolean {
        return this.busy;
    }

    getLatency(): number {
        return this.lastLatency;
    }

    async sendMessage(message: IMessage): Promise<{ response: string; latency: number; }> {
        this.busy = true;
        const startTime = performance.now();
        const url = `https://api.openai.com/v1/chat/completions`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
        };

        const data = { prompt: message.content, model: message.model.id };

        try {
            const response = await axios.post(url, data, { headers });
            const endTime = performance.now();
            this.lastLatency = endTime - startTime;
            this.busy = false;

            await updateModelLatency(message.model.id, message.model.provider, this.lastLatency);

            if (response.data.choices && response.data.choices.length > 0) {
                return {
                    response: response.data.choices[0].text,
                    latency: this.lastLatency
                };
            } else {
                return { response: 'Unexpected response structure', latency: this.lastLatency };
            }
        } catch (error) {
            console.error('Error sending message:', error);
            this.busy = false;
            throw error;
        }
    }
}