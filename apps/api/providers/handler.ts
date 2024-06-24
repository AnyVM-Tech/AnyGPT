import { readFileSync } from 'fs';
import { GeminiAI } from 'providers/gemini';
import { OpenAI } from 'providers/openai';
import dotenv from 'dotenv';
dotenv.config();

interface IAIProvider {
  sendMessage(message: string): Promise<{ response: string, latency: number }>;
}

interface ModelEntry {
  id: string;
}

interface Models {
  [provider: string]: ModelEntry[];
}

const models: Models = JSON.parse(readFileSync('models.json', 'utf8'));

const providerClassMap: { [provider: string]: new (...args: any[]) => IAIProvider } = {
  google: GeminiAI,
  openai: OpenAI,
  // add other providers here
};

function getModelClass(model: string): new (...args: any[]) => IAIProvider {
  for (const [provider, modelEntries] of Object.entries(models)) {
    const found = modelEntries.some(entry => entry.id === model);
    if (found) {
      const ModelClass = providerClassMap[provider];
      if (ModelClass) return ModelClass;
      throw new Error(`Unsupported model group: ${provider}`);
    }
  }
  throw new Error(`Unsupported model: ${model}`);
}

export class MessageHandler {
  static async handleMessages(
    messages: { role: string; content: string }[] | { [key: string]: any },
    model: string
  ): Promise<{ response: string; latency: number }> {
    console.log("handleMessages called with messages:", messages);

    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: "No valid messages provided.", latency: 0 };
    }

    const startTime = Date.now();
    let responseText = "";

    try {
      const aiModelClass = getModelClass(model);
      const aiModel = new aiModelClass(model);
      const serializedMessages = JSON.stringify({ model, messages });
      console.log("serializedMessages", serializedMessages);

      const aiResponse = await aiModel.sendMessage(serializedMessages);
      responseText = aiResponse.response;
      console.log("AI response:", aiResponse);
    } catch (error: any) {
      console.error("Error:", error.message);
      responseText = `Error: ${error.message}`;
    }

    const endTime = Date.now();
    return { response: responseText.trim(), latency: endTime - startTime };
  }
}