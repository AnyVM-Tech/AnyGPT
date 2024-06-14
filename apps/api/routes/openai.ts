import { Server } from 'hyper-express';
import dotenv from 'dotenv';

dotenv.config();

// Simple IoC Container
class Container {
  private dependencies: Record<string, any> = {};

  register(key: string, constructor: any) {
    this.dependencies[key] = constructor;
  }

  resolve(key: string) {
    if (!this.dependencies[key]) {
      throw new Error(`Dependency ${key} not found`);
    }
    return this.dependencies[key];
  }
}

// Interface for AI models
interface IAIModel {
  sendMessage(message: string): Promise<{ response: string; latency: number }>;
}

// IoC container instance
const container = new Container();

// Function to create AI model instances based on a given model name
function createAIModel(modelName: string): IAIModel {
  return container.resolve(modelName);
}

// Function to extract message and model from request
export async function extractMessageFromRequest(request: any): Promise<{ message: string; model: string }> {
  const requestBody = await request.json();
  return { message: requestBody.message, model: requestBody.model || 'defaultModel' };
}

// Setup routes function for server initialization
export function setupRoutes(server: Server) {
  server.post('/openai', async (request, response) => {
    try {
      const { message, model } = await extractMessageFromRequest(request);
      const aiModel = createAIModel(model); 
      const result = await aiModel.sendMessage(message);
      console.log('Received message:', message);
      response.status(200).json({ message: "Message received, processing...", result });
    } catch (error) {
      console.error('Error receiving message:', error);
      response.status(500).send('Error receiving message');
    }
  });
}

// Example of registering a dependency
// container.register('defaultModel', new SomeAIModelClass(process.env.API_KEY || ''));