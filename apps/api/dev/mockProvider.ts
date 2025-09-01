import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import HyperExpress from 'hyper-express';
import { randomUUID } from 'crypto';

const app = new HyperExpress.Server();


const port = 3001; // Different port from main API

// Configurable mock settings
interface MockConfig {
  baseDelay: number;        // Base response delay in ms
  delayVariance: number;    // Random variance in delay (±ms)
  errorRate: number;        // Error rate (0.0 to 1.0)
  timeoutRate: number;      // Timeout rate (0.0 to 1.0)
  slowResponseRate: number; // Rate of artificially slow responses (0.0 to 1.0)
  slowResponseDelay: number; // Additional delay for slow responses in ms
  tokenSpeed: number;       // Tokens per second simulation
  enableLogs: boolean;      // Enable/disable detailed logging
}

// Default configuration (can be overridden via environment variables or API)
let mockConfig: MockConfig = {
  baseDelay: parseInt(process.env.MOCK_BASE_DELAY || '100'),
  delayVariance: parseInt(process.env.MOCK_DELAY_VARIANCE || '100'),
  errorRate: parseFloat(process.env.MOCK_ERROR_RATE || '0.0'),
  timeoutRate: parseFloat(process.env.MOCK_TIMEOUT_RATE || '0.0'),
  slowResponseRate: parseFloat(process.env.MOCK_SLOW_RATE || '0.0'),
  slowResponseDelay: parseInt(process.env.MOCK_SLOW_DELAY || '2000'),
  tokenSpeed: parseInt(process.env.MOCK_TOKEN_SPEED || '50'),
  enableLogs: process.env.MOCK_ENABLE_LOGS !== 'false'
};

// Helper function to simulate realistic response timing
function calculateResponseDelay(outputTokens: number): number {
  const baseDelay = mockConfig.baseDelay + (Math.random() * mockConfig.delayVariance * 2) - mockConfig.delayVariance;
  
  // Simulate token generation delay based on token speed
  const tokenDelay = (outputTokens / mockConfig.tokenSpeed) * 1000; // Convert to ms
  
  // Check for slow response simulation
  const isSlowResponse = Math.random() < mockConfig.slowResponseRate;
  const slowDelay = isSlowResponse ? mockConfig.slowResponseDelay : 0;
  
  const totalDelay = Math.max(baseDelay + tokenDelay + slowDelay, 50); // Minimum 50ms
  
  if (mockConfig.enableLogs) {
    console.log(`[MOCK] Response delay calculation: base=${baseDelay.toFixed(0)}ms, tokens=${tokenDelay.toFixed(0)}ms, slow=${slowDelay}ms, total=${totalDelay.toFixed(0)}ms`);
  }
  
  return totalDelay;
}

// Configuration endpoint to update mock settings at runtime
app.post('/mock/config', async (request, response) => {
  try {
    const newConfig = await request.json();
    
    // Validate and update configuration
    if (newConfig.baseDelay !== undefined) mockConfig.baseDelay = Math.max(0, newConfig.baseDelay);
    if (newConfig.delayVariance !== undefined) mockConfig.delayVariance = Math.max(0, newConfig.delayVariance);
    if (newConfig.errorRate !== undefined) mockConfig.errorRate = Math.max(0, Math.min(1, newConfig.errorRate));
    if (newConfig.timeoutRate !== undefined) mockConfig.timeoutRate = Math.max(0, Math.min(1, newConfig.timeoutRate));
    if (newConfig.slowResponseRate !== undefined) mockConfig.slowResponseRate = Math.max(0, Math.min(1, newConfig.slowResponseRate));
    if (newConfig.slowResponseDelay !== undefined) mockConfig.slowResponseDelay = Math.max(0, newConfig.slowResponseDelay);
    if (newConfig.tokenSpeed !== undefined) mockConfig.tokenSpeed = Math.max(1, newConfig.tokenSpeed);
    if (newConfig.enableLogs !== undefined) mockConfig.enableLogs = Boolean(newConfig.enableLogs);
    
    console.log('[MOCK] Configuration updated:', mockConfig);
    response.json({ success: true, config: mockConfig });
  } catch (error) {
    console.error('[MOCK] Error updating configuration:', error);
    response.status(400).json({ error: 'Invalid configuration data' });
  }
});

// Get current configuration
app.get('/mock/config', async (request, response) => {
  response.json(mockConfig);
});

// Reset configuration to defaults
app.post('/mock/reset', async (request, response) => {
  mockConfig = {
    baseDelay: 100,
    delayVariance: 100,
    errorRate: 0.0,
    timeoutRate: 0.0,
    slowResponseRate: 0.0,
    slowResponseDelay: 2000,
    tokenSpeed: 50,
    enableLogs: true
  };
  console.log('[MOCK] Configuration reset to defaults');
  response.json({ success: true, config: mockConfig });
});

// Mock OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (request, response) => {
  const body = await request.json();
  
  if (mockConfig.enableLogs) {
    console.log('[MOCK] Received chat completion request:', JSON.stringify(body, null, 2));
  }
  
  const { model, messages, max_tokens = 150, temperature = 0.7, stream = true } = body;
  
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return response.status(400).json({
      error: {
        message: "Invalid request: messages array is required",
        type: "invalid_request_error"
      }
    });
  }

  // Simulate timeout
  if (Math.random() < mockConfig.timeoutRate) {
    if (mockConfig.enableLogs) {
      console.log('[MOCK] Simulating timeout');
    }
    // Don't respond at all to simulate timeout
    return;
  }

  // Simulate various error types
  if (Math.random() < mockConfig.errorRate) {
    const errorTypes = [
      {
        status: 429,
        error: {
          message: "Rate limit exceeded. Please retry after some time.",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded"
        }
      },
      {
        status: 500,
        error: {
          message: "Internal server error occurred during processing.",
          type: "internal_server_error",
          code: "internal_error"
        }
      },
      {
        status: 503,
        error: {
          message: "Service temporarily unavailable. Please retry later.",
          type: "service_unavailable",
          code: "service_unavailable"
        }
      },
      {
        status: 400,
        error: {
          message: "Invalid request format or parameters.",
          type: "invalid_request_error",
          code: "invalid_request"
        }
      }
    ];
    
    const errorResponse = errorTypes[Math.floor(Math.random() * errorTypes.length)];
    
    if (mockConfig.enableLogs) {
      console.log(`[MOCK] Simulating error: ${errorResponse.status} - ${errorResponse.error.message}`);
    }
    
    return response.status(errorResponse.status).json(errorResponse.error);
  }

  const userMessage = messages[messages.length - 1]?.content || '';
  
  // Generate mock responses based on content
  let mockContent = '';
  if (userMessage.toLowerCase().includes('haiku')) {
    mockContent = `APIs flowing fast,
Data streams through digital paths,
Code connects all worlds.`;
  } else if (userMessage.toLowerCase().includes('hello')) {
    mockContent = 'Hello! I am a mock AI provider. How can I help you today?';
  } else if (userMessage.toLowerCase().includes('error')) {
    mockContent = 'I understand you mentioned errors. Here are some common API error types: authentication errors, rate limiting, timeouts, and server errors.';
  } else if (userMessage.toLowerCase().includes('test')) {
    mockContent = `Test response generated at ${new Date().toISOString()}. Current mock config: delay=${mockConfig.baseDelay}ms±${mockConfig.delayVariance}ms, error_rate=${mockConfig.errorRate}, token_speed=${mockConfig.tokenSpeed}tps.`;
  } else {
    mockContent = `This is a mock response to your message: "${userMessage}". I'm a simulated AI provider for testing purposes.`;
  }

  // Calculate mock token usage
  const inputTokens = Math.ceil(userMessage.length / 4); // Rough estimate: 4 chars per token
  const outputTokens = Math.ceil(mockContent.length / 4);
  const totalTokens = inputTokens + outputTokens;

  // Calculate realistic response delay
  const processingDelay = calculateResponseDelay(outputTokens);
  
  // Handle streaming requests
  if (stream) {
    if (mockConfig.enableLogs) {
      console.log('[MOCK] Handling streaming request');
    }
    
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelName = model || 'mock-gpt-3.5-turbo';
    
    // Split content into chunks for streaming
    const chunkSize = 3; // characters per chunk
    const chunks: string[] = [];
    for (let i = 0; i < mockContent.length; i += chunkSize) {
      chunks.push(mockContent.substring(i, i + chunkSize));
    }
    
    setTimeout(async () => {
      try {
        // Send chunks
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const streamChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: created,
            model: modelName,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          
          response.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
          
          // Small delay between chunks to simulate real streaming
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Send final chunk
        const finalChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: created,
          model: modelName,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
        
        response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        response.write(`data: [DONE]\n\n`);
        response.end();
        
        if (mockConfig.enableLogs) {
          console.log(`[MOCK] Streaming response completed for request ${requestId}`);
        }
      } catch (error) {
        console.error('[MOCK] Error during streaming:', error);
        response.end();
      }
    }, processingDelay);
    
    return;
  }
  
  // Handle non-streaming requests
  setTimeout(() => {
    const responseData = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'mock-gpt-3.5-turbo',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: mockContent
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens
      },
      system_fingerprint: 'mock_provider_fp_123'
    };

    if (mockConfig.enableLogs) {
      console.log('[MOCK] Sending response:', JSON.stringify(responseData, null, 2));
    }
    response.json(responseData);
  }, processingDelay);
});

// Mock models endpoint
app.get('/v1/models', async (request, response) => {
  console.log('[MOCK] Received models list request');
  
  const responseData = {
    object: 'list',
    data: [
      {
        id: 'mock-gpt-3.5-turbo',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mock-provider',
        permission: [],
        root: 'mock-gpt-3.5-turbo',
        parent: null
      },
      {
        id: 'mock-gpt-4',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mock-provider',
        permission: [],
        root: 'mock-gpt-4',
        parent: null
      }
    ]
  };

  console.log('[MOCK] Sending models response');
  response.json(responseData);
});

// Health check endpoint
app.get('/health', async (request, response) => {
  response.json({ status: 'ok', provider: 'mock', timestamp: new Date().toISOString() });
});

// Start the mock provider server
app.listen(port, () => {
  console.log(`🎭 Mock Provider Server running on http://localhost:${port}`);
  console.log(`Available endpoints:`);
  console.log(`  POST /v1/chat/completions - Mock chat completions`);
  console.log(`  GET  /v1/models - Mock models list`);
  console.log(`  GET  /health - Health check`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🎭 Mock Provider Server shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🎭 Mock Provider Server shutting down...');
  process.exit(0);
});