import { readFileSync } from 'fs';
import { GeminiAI } from 'providers/gemini';
import dotenv from 'dotenv';
dotenv.config();
interface IAIModel {
  sendMessage(message: string): Promise<{ response: string; latency: number }>;
}

// AIModelIdentifier now returns the class reference instead of an instance
class AIModelIdentifier {
  private static models = JSON.parse(readFileSync('models.json', 'utf8'));

  static getModelClass(model: string): typeof GeminiAI | undefined {
    for (const group in AIModelIdentifier.models) {
      const foundModel = AIModelIdentifier.models[group].find((m: any) => m.id === model);
      if (foundModel) {
        switch (group) {
          case 'google':
            return GeminiAI;
          default:
            throw new Error(`Unsupported group: ${group}`);
        }
      }
    }
    throw new Error(`Unsupported model: ${model}`);
  }
}

// MessageHandler uses the class reference to instantiate an object
export class MessageHandler {
  static async handleMessages(
    messages: { role: string; content: string }[] | [] | { [key: string]: any },
    model: string
  ): Promise<{ response: string; latency: number }> {
    console.log("handleMessages called with messages:", messages); // Debug log

    if (Array.isArray(messages) && messages.length === 0) {
      return { response: "No messages provided.", latency: 0 };
    }

    if (!Array.isArray(messages)) {
      return { response: "Invalid message format.", latency: 0 };
    }

    console.log("Messages are valid, proceeding..."); // Debug log

    let responseText = "";
    let startTime = Date.now();

    let aiModelClass;
    try {
      console.log("Attempting to get AI model class for model:", model); // Debug log
      aiModelClass = AIModelIdentifier.getModelClass(model);
      console.log("AI model class obtained:", aiModelClass); // Debug log

      if (!aiModelClass) {
        throw new Error(`Model class not found for ${model}`);
      }
    } catch (error: any) {
      console.error("Error getting AI model class:", error.message); // Error log
      return { response: `Error getting AI model class: ${error.message}`, latency: 0 };
    }

    console.log("guh"); // Original log

    // Instantiate the AI model with necessary parameters
    const aiModel = new aiModelClass(model);

    for (const message of messages) {
      switch (message.role) {
        case "system":
          responseText += `System: ${message.content}\n`;
          break;
        case "user":
          try {
            const aiResponse = await aiModel.sendMessage(message.content);
            responseText += `AI: ${aiResponse.response}\n`;
            console.log("this s a log", aiResponse)
          } catch (error: any) {
            responseText += `Error processing message: ${error.message}\n`;
          }
          break;
        default:
          responseText += `Unknown role: ${message.role} with content: ${message.content}\n`;
          
      }
    }

    let endTime = Date.now();
    console.log(responseText.trim())
    return { response: responseText.trim(), latency: endTime - startTime };

  }
}