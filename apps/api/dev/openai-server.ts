import { Server, Router } from 'hyper-express';
import { v4 as uuidv4 } from 'uuid';

const app = new Server();
const router = new Router();
const port = 3080;

// Configuration
const config = {
  // Artificial delay in ms to simulate network latency
  responseDelay: 500,
  // Random failure rate (0-1) - disabled for testing
  failureRate: 0,
  // Token generation speed (tokens per second)
  tokenGenerationSpeed: 20,
};

// Simple token counter (rough estimation)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Generate a mock response
function generateResponse(prompt: string, modelId: string): string {
  return `This is a mock response from the OpenAI API simulator for model ${modelId}. You asked: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
}

// Mock completion endpoint
router.post('/v1/chat/completions', async (req, res) => {
  const body = await req.json();
  const { model, messages, temperature = 0.7, max_tokens = 256 } = body;

  // Validate required fields
  if (!model || !messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Invalid request. Model and messages are required. Messages must be a non-empty array.',
        type: 'invalid_request_error',
        param: !model ? 'model' : 'messages',
        code: 'parameter_error',
      }
    });
  }

  // Simulate random failures
  if (Math.random() < config.failureRate) {
    return res.status(500).json({
      error: {
        message: 'The server had an error processing your request. Sorry about that!',
        type: 'server_error',
        code: 'internal_error',
      }
    });
  }

  // Get the last user message
  const userMessage = messages.filter(m => m.role === 'user').pop();
  const userContent = userMessage ? userMessage.content : '';

  // Generate response
  const responseContent = generateResponse(userContent, model);
  
  // Calculate token counts
  const promptTokens = estimateTokens(userContent);
  const completionTokens = estimateTokens(responseContent);
  
  // Calculate realistic response time based on token generation speed
  const baseDelay = config.responseDelay;
  const generationTime = (completionTokens / config.tokenGenerationSpeed) * 1000;
  const totalDelay = baseDelay + generationTime;
  
  // Send response after delay
  await new Promise(resolve => setTimeout(resolve, totalDelay));
  
  return res.json({
    id: `chatcmpl-${uuidv4().substring(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: responseContent,
        },
        index: 0,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
});

// Models list endpoint
router.get('/v1/models', (req, res) => {
  return res.json({
    object: 'list',
    data: [
      {
        id: 'gpt-3.5-turbo',
        object: 'model',
        created: 1677610602,
        owned_by: 'openai',
      },
      {
        id: 'gpt-4',
        object: 'model',
        created: 1687882411,
        owned_by: 'openai',
      }
    ]
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  return res.send('OK');
});

// Register router
app.use('/', router);

// Set up CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).send();
  }
  
  return next();
});

// Start the server
app.listen(port)
  .then(() => {
    console.log(`Mock OpenAI server running at http://localhost:${port}`);
    console.log(`Configuration: 
    - Response delay: ${config.responseDelay}ms
    - Random failure rate: ${config.failureRate * 100}%
    - Token generation speed: ${config.tokenGenerationSpeed} tokens/sec`);
  })
  .catch(error => {
    console.error('Failed to start server:', error);
  });

// Export for testing
export default app;