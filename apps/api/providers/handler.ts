import { readFileSync } from 'fs';
import { GeminiAI } from 'providers/gemini';
import dotenv from 'dotenv';
import {OpenAI} from 'providers/openai';
dotenv.config();
interface IAIProvider {
  sendMessage(message: string): Promise<{response: string, latency: number}>;
}
class AIModelIdentifier {
  private static models = JSON.parse(readFileSync('models.json', 'utf8'));

  static getModelClass(model: string): new (...args: any[]) => IAIProvider {
    for (const group in AIModelIdentifier.models) {
      const foundModel = AIModelIdentifier.models[group].find((m: any) => m.id === model);
      if (foundModel) {
        switch (group) {
          case 'google':
            return GeminiAI;
          case 'openai':
            return OpenAI;
          // add cases for more providers
        }
      }
    }
    throw new Error(`Unsupported model: ${model}`);
  }
}


export class MessageHandler {
  static async handleMessages(
    messages: { role: string; content: string }[] | [] | { [key: string]: any },
    model: string
  ): Promise<{ response: string; latency: number }> {
    console.log("handleMessages called with messages:", messages);

    if (Array.isArray(messages) && messages.length === 0) {
      return { response: "No messages provided.", latency: 0 };
    }

    if (!Array.isArray(messages)) {
      return { response: "Invalid message format.", latency: 0 };
    }

    let startTime = Date.now();

    let aiModelClass;
    try {
      aiModelClass = AIModelIdentifier.getModelClass(model);
      if (!aiModelClass) {
        throw new Error(`Model class not found for ${model}`);
      }
    } catch (error: any) {
      console.error("Error getting AI model class:", error.message);
      return { response: `Error getting AI model class: ${error.message}`, latency: 0 };
    }

    const aiModel = new aiModelClass(model);
    let responseText = "";

const serializedMessages = JSON.stringify(messages);
console.log("serializedMessages", serializedMessages);

try {
  const messagesArray = JSON.parse(serializedMessages);
  const data = {
    model: model,
    messages: messagesArray 

  };

  const aiResponse = await aiModel.sendMessage(JSON.stringify(data));
  responseText = `${aiResponse.response}\n`;
  console.log("AI response:", aiResponse);
} catch (error: any) {
  responseText = `Error processing messages: ${error.message}\n`;
}

let endTime = Date.now();
return { response: responseText.trim(), latency: endTime - startTime };
}
}