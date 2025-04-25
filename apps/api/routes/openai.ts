import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
// Import the singleton instance, not the class
import { messageHandler } from '../providers/handler';
// Import IMessage interface
import { IMessage } from '../providers/interfaces';
import { generateUserApiKey, validateApiKey, extractMessageFromRequest, updateUserTokenUsage } from '../modules/userData';
dotenv.config();

const server = new HyperExpress.Server();

declare module 'hyper-express' {
  interface Request {
    apiKey?: string;
    userId?: string;
    userRole?: string;
    userTokenUsage?: number;
  }
}

async function apiKeyMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return response.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }

  const apiKey = authHeader.slice(7);

  const userData = validateApiKey(apiKey);

  if (!userData) {
    return response.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }


  request.apiKey = apiKey; // Attach the validated API key to the request object
  request.userId = userData.userId;
  request.userRole = userData.role;
  request.userTokenUsage = userData.tokenUsage;
  next();
}


server.post('/generate_key', apiKeyMiddleware, async (request: Request, response: Response) => {
  try {
    if (request.userRole !== 'admin') {
      return response.status(403).json({ error: 'Forbidden: Only admins can generate user API keys' });
    }

    const { userId } = await request.json();
    if (!userId) {
      return response.status(400).json({ error: 'Bad Request: userId is required to generate a new user API key' });
    }

    const newUserApiKey = generateUserApiKey(userId);
    response.json({ apiKey: newUserApiKey });
  } catch (error: any) {
    console.error('Error generating API key:', error.message);
    response.status(500).json({ error: error.message });
  }
});


server.use('/v1', apiKeyMiddleware); // Apply middleware to all /v1 routes

server.post('/v1/chat/completions', async (request: Request, response: Response) => {
  // Guard to prevent double processing (if applicable)
  // if ((request as any)._processed) return;
  // (request as any)._processed = true;

  try {
    // Extract messages (still {role, content}) and model ID
    const { messages: rawMessages, model: modelId } = await extractMessageFromRequest(request);
    console.log('Received messages:', rawMessages, 'Model:', modelId);

    // Get the API key attached by the middleware
    const userApiKey = request.apiKey;
    if (!userApiKey) {
        console.error("API key missing from request after middleware.");
        return response.status(401).json({ error: 'Unauthorized: API Key missing internally.'});
    }

    // --- Transform messages to match IMessage interface --- 
    const formattedMessages: IMessage[] = rawMessages.map(msg => ({
        content: msg.content,
        // Add the model object to each message as required by IMessage
        model: { id: modelId }
        // Note: Role is not part of IMessage, so it's omitted here.
        // MessageHandler likely only uses the last message's content.
    }));

    // Pass the formatted messages, modelId, and apiKey to handleMessages
    const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);

    console.log('Response:', result);

    // Token usage update seems to use the key correctly already
    const totalTokensUsed = result.tokenUsage || 0;
    if (request.apiKey) { // Or use userApiKey here
      updateUserTokenUsage(totalTokensUsed, request.apiKey);
    }

    response.json(result);
  } catch (error: any) { // Catch any errors from handleMessages or earlier
    console.error('Error in /v1/chat/completions:', error.message);
    response.status(500).json({ error: 'Internal Server Error' });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port);
console.log(`Server is listening on port ${port}`);
