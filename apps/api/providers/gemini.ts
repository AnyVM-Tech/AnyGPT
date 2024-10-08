import dotenv from 'dotenv';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerativeModel
} from '@google/generative-ai';
import { IAIProvider, IMessage } from './interfaces';

dotenv.config();

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

export class GeminiAI implements IAIProvider {
  private model: GenerativeModel;
  private busy: boolean = false;
  private lastLatency: number = 0;

  constructor(apiKey: string, modelId: string) {
    if (!apiKey) {
      throw new Error('API key is not defined in environment variables');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: modelId
    });
  }

  isBusy(): boolean {
    return this.busy;
  }

  getLatency(): number {
    return this.lastLatency;
  }

  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    this.busy = true;
    const startTime = Date.now();

    try {
      const chatSession = this.model.startChat({
        generationConfig,
        safetySettings,
        history: [] // Include conversation history if needed
      });

      const result = await chatSession.sendMessage(message.content);
      console.log('Result:', result);

      const endTime = Date.now();
      this.lastLatency = endTime - startTime;
      this.busy = false;

      return {
        response: await result.response.text(),
        latency: this.lastLatency
      };
    } catch (error) {
      console.error('Error in Gemini API call:', error);
      this.busy = false;
      throw new Error('Error in Gemini API call');
    }
  }
}