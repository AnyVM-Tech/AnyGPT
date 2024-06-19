import dotenv from 'dotenv';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  GenerativeModel
} from '@google/generative-ai';

dotenv.config();   // cannot directly input messages to the model, it will not respond correctly as history and message are different,
// currently messages are passed as one long string for object message 

interface IAIProvider {
  sendMessage(message: string): Promise<{response: string, latency: number}>;
}
export class GeminiAI implements IAIProvider {
  private model: GenerativeModel;
  private generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: 'text/plain'
  };
  private safetySettings = [
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

  constructor(model: string) {
    const apiKey = process.env.GEMINI_API_KEY; 
    if (!apiKey) {
      throw new Error('API key is not defined in .env');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: model
    });
  }

  async sendMessage(message: string): Promise<{response: string, latency: number}> {
    const startTime = Date.now();
  
    try {
      const chatSession = this.model.startChat({
        generationConfig: this.generationConfig,
        safetySettings: this.safetySettings,
        history: []
      });
  
      const result = await chatSession.sendMessage(message);
      console.log('Result:', result);
  
      const endTime = Date.now();
  
      return {
        response: await result.response.text(),
        latency: endTime - startTime
      };
    } catch (error) {
      console.error('Error in Gemini API call:', error);
      throw new Error('Error in Gemini API call');
    }
  }
}