import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { MessageHandler } from '../providers/handler';
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


  request.apiKey = apiKey;
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


server.use('/v1', apiKeyMiddleware);

server.post('/v1/chat/completions', async (request: Request, response: Response) => {
  // Guard to prevent double processing
  if ((request as any)._processed) return;
  (request as any)._processed = true;

  try {
    const { messages, model } = await extractMessageFromRequest(request);
    console.log('Received messages:', messages, 'Model:', model);

    const messageHandler = new MessageHandler();


    const messagesWithModel = messages.map(message => ({ ...message, model: { id: model } }));
    const result = await messageHandler.handleMessages(messagesWithModel, model);

    console.log('Response:', result);

    const totalTokensUsed = result.tokenUsage || 0;

    if (request.apiKey) {
      updateUserTokenUsage(totalTokensUsed, request.apiKey);
    }

    response.json(result);
  } catch (error) {
    console.error('Error receiving messages:', error);
    response.status(500).json({ error: 'Internal Server Error' });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port);
console.log(`Server is listening on port ${port}`);