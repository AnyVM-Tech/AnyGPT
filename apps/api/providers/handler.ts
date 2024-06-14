import { GeminiAI } from './GeminiAI';


interface IAIModel {
  sendMessage(message: string): Promise<{ response: string; latency: number }>;
}

class AnotherAIModel implements IAIModel {
  async sendMessage(message: string): Promise<{ response: string; latency: number }> {
    return { response: `AnotherAIModel response to: ${message}`, latency: 100 };
  }
}
class AIModelIdentifier {
  static getModel(modelName: string): IAIModel {
    switch (modelName) {
      case 'gemini-1.5-pro':
        return new GeminiAI(process.env.API_KEY || '');
      case 'another-model':
        return new AnotherAIModel();
      default:
        throw new Error(`Unsupported model: ${modelName}`);
    }
  }
}

