import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import HyperExpress from '../lib/uws-compat.js';
import { randomUUID } from 'crypto';

const app = new HyperExpress.Server();


const port = parseInt(process.env.MOCK_PROVIDER_PORT || '3001', 10); // Different port from main API

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

function extractResponsesInputText(input: any): string {
  if (typeof input === 'string') return input;
  if (!input) return '';
  if (Array.isArray(input)) {
    return input.map((entry) => extractResponsesInputText(entry)).filter(Boolean).join('\n');
  }
  if (typeof input === 'object') {
    if (typeof input.text === 'string') return input.text;
    if (typeof input.content === 'string') return input.content;
    if (Array.isArray(input.content)) {
      return input.content.map((part: any) => extractResponsesInputText(part)).filter(Boolean).join('\n');
    }
  }
  return '';
}

function writeSseEvent(response: any, payload: Record<string, any>) {
  response.write(`event: ${payload.type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const normalizedChunkSize = Number.isFinite(chunkSize) && chunkSize > 0
    ? Math.floor(chunkSize)
    : text.length;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += normalizedChunkSize) {
    chunks.push(text.slice(index, index + normalizedChunkSize));
  }
  return chunks;
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
  
  const { model, messages, max_tokens = 150, temperature = 0.7, stream = false } = body;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  
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
  const requestedToolName = typeof tools[0]?.function?.name === 'string'
    ? tools[0].function.name
    : (typeof tools[0]?.name === 'string' ? tools[0].name : 'mock_tool');
  const mockToolCall = tools.length > 0
    ? {
        id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: requestedToolName,
          arguments: JSON.stringify({ city: 'NYC' })
        }
      }
    : null;

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

    await new Promise(resolve => setTimeout(resolve, processingDelay));

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
    
    return;
  }
  
  // Handle non-streaming requests
  await new Promise(resolve => setTimeout(resolve, processingDelay));

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
            content: mockToolCall ? null : mockContent,
            ...(mockToolCall ? { tool_calls: [mockToolCall] } : {})
          },
          finish_reason: mockToolCall ? 'tool_calls' : 'stop'
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
});

app.post('/v1/responses', async (request, response) => {
  const body = await request.json();

  if (mockConfig.enableLogs) {
    console.log('[MOCK] Received responses request:', JSON.stringify(body, null, 2));
  }

  const model = typeof body?.model === 'string' ? body.model : 'mock-gpt-5.4';
  const stream = body?.stream === true;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const userMessage = extractResponsesInputText(body?.input);

  let mockContent = '';
  if (userMessage.toLowerCase().includes('haiku')) {
    mockContent = `APIs connect bright,\nRequests flow through one clear gateway,\nSDKs rest easy.`;
  } else if (userMessage.toLowerCase().includes('hello')) {
    mockContent = 'Hello from the mock Responses API.';
  } else {
    mockContent = `This is a mock responses reply to: "${userMessage}".`;
  }

  const inputTokens = Math.ceil(userMessage.length / 4);
  const outputTokens = Math.ceil(mockContent.length / 4);
  const totalTokens = inputTokens + outputTokens;
  const processingDelay = calculateResponseDelay(outputTokens);
  const requestedToolName = typeof tools[0]?.function?.name === 'string'
    ? tools[0].function.name
    : (typeof tools[0]?.name === 'string' ? tools[0].name : 'mock_tool');
  const responseId = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const reasoningId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const functionCallId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const mockReasoning = tools.length > 0
    ? 'Selecting the best tool and preparing its arguments.'
    : 'Planning the response before generating the final answer.';
  const reasoningChunks = splitTextIntoChunks(mockReasoning, 14);
  const mockFunctionCall = tools.length > 0
    ? {
        id: functionCallId,
        type: 'function_call',
        call_id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: requestedToolName,
        arguments: JSON.stringify({ city: 'NYC' }),
        status: 'completed',
      }
    : null;

  const finalResponse = {
    id: responseId,
    object: 'response',
    created,
    model,
    status: 'completed',
    output: mockFunctionCall
      ? [{
          id: reasoningId,
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: mockReasoning }],
        }, {
          id: messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: '' },
            { type: 'tool_calls', tool_calls: [mockFunctionCall] }
          ],
        }, mockFunctionCall]
      : [{
          id: reasoningId,
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: mockReasoning }],
        }, {
          id: messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: mockContent }],
        }],
    output_text: mockFunctionCall ? '' : mockContent,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };

  if (!stream) {
    await new Promise((resolve) => setTimeout(resolve, processingDelay));
    response.json(finalResponse);
    return;
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  await new Promise((resolve) => setTimeout(resolve, processingDelay));

  writeSseEvent(response, {
    type: 'response.created',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response: {
      id: responseId,
      object: 'response',
      created,
      model,
      status: 'in_progress',
      output: [],
      output_text: '',
    },
  });

  writeSseEvent(response, {
    type: 'response.output_item.added',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response_id: responseId,
    output_index: 0,
    item: {
      id: reasoningId,
      type: 'reasoning',
      status: 'in_progress',
      summary: [],
    },
  });
  writeSseEvent(response, {
    type: 'response.reasoning_summary_part.added',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response_id: responseId,
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  });
  for (const delta of reasoningChunks) {
    writeSseEvent(response, {
      type: 'response.reasoning_summary_text.delta',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  writeSseEvent(response, {
    type: 'response.reasoning_summary_text.done',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response_id: responseId,
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    text: mockReasoning,
  });
  writeSseEvent(response, {
    type: 'response.reasoning_summary_part.done',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response_id: responseId,
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: mockReasoning },
  });
  writeSseEvent(response, {
    type: 'response.output_item.done',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response_id: responseId,
    output_index: 0,
    item: {
      id: reasoningId,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: mockReasoning }],
    },
  });

  if (mockFunctionCall) {
    writeSseEvent(response, {
      type: 'response.output_item.added',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [
          { type: 'output_text', text: '' },
          { type: 'tool_calls', tool_calls: [mockFunctionCall] }
        ],
      },
    });
    writeSseEvent(response, {
      type: 'response.output_item.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: '' },
          { type: 'tool_calls', tool_calls: [mockFunctionCall] }
        ],
      },
    });
    writeSseEvent(response, {
      type: 'response.output_item.added',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 2,
      item: { ...mockFunctionCall, status: 'in_progress' },
    });
    writeSseEvent(response, {
      type: 'response.function_call_arguments.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 2,
      item_id: mockFunctionCall.id,
      call_id: mockFunctionCall.call_id,
      name: mockFunctionCall.name,
      arguments: mockFunctionCall.arguments,
    });
    writeSseEvent(response, {
      type: 'response.output_item.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 2,
      item: mockFunctionCall,
    });
  } else {
    writeSseEvent(response, {
      type: 'response.output_item.added',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
    writeSseEvent(response, {
      type: 'response.content_part.added',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });

    for (const delta of splitTextIntoChunks(mockContent, 4)) {
      writeSseEvent(response, {
        type: 'response.output_text.delta',
        event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        response_id: responseId,
        output_index: 1,
        item_id: messageId,
        content_index: 0,
        delta,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    writeSseEvent(response, {
      type: 'response.output_text.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      text: mockContent,
    });
    writeSseEvent(response, {
      type: 'response.content_part.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      part: { type: 'output_text', text: mockContent },
    });
    writeSseEvent(response, {
      type: 'response.output_item.done',
      event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      response_id: responseId,
      output_index: 1,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: mockContent }],
      },
    });
  }

  writeSseEvent(response, {
    type: 'response.completed',
    event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    response: finalResponse,
  });
  response.write('data: [DONE]\n\n');
  response.end();
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
        id: 'gpt-5.4',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mock-provider',
        permission: [],
        root: 'gpt-5.4',
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
app.listen(port).then(() => {
  console.log(`🎭 Mock Provider Server running on http://localhost:${port}`);
  console.log(`Available endpoints:`);
  console.log(`  POST /v1/chat/completions - Mock chat completions`);
  console.log(`  GET  /v1/models - Mock models list`);
  console.log(`  GET  /health - Health check`);
}).catch((error) => {
  console.error('Failed to start Mock Provider Server:', error);
  process.exit(1);
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
