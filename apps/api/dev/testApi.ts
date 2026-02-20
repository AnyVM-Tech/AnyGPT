import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import axios from 'axios';
import { config } from 'dotenv';
import { setupMockProviderConfig, restoreProviderConfig } from './testSetup.js';

// Load environment variables (optional, server should have them)
config();

async function testApiWithMockProvider() {
  const manageSetup = process.env.TEST_SETUP_MODE !== 'external';
  if (manageSetup) {
    // Setup mock provider configuration
    setupMockProviderConfig();
  }
  
  const port = process.env.PORT || '3000';
  const baseUrl = process.env.TEST_API_BASE_URL || `http://localhost:${port}`;
  const apiUrl = `${baseUrl}/v1/chat/completions`;
  const modelId = 'gpt-3.5-turbo';
  const testPrompt = 'Write a short haiku about APIs.';
  // Use an existing admin API key that we know is valid
  const apiKey = process.env.TEST_API_KEY || 'test-key-for-mock-provider';

  console.log(`[TEST] Testing API endpoint: ${apiUrl}`);
  console.log(`[TEST] Using model: ${modelId}`);
  console.log(`[TEST] Mock provider should be configured for this test`);

  try {
    const requestBody = {
      model: modelId,
      messages: [
        { role: 'user', content: testPrompt }
      ],
      stream: true // Test streaming since mock provider is streamingCompatible: true
    };

    console.log('[TEST] Sending request...');
    const startTime = Date.now();
    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 10000
    });
    const latency = Date.now() - startTime;

    console.log('[TEST] --- API Test Result ---');
    console.log('[TEST] Status Code:', response.status);
    console.log('[TEST] Latency:', latency, 'ms');
    console.log('[TEST] Response Data:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('[TEST] -----------------------');

    // Check for streaming response structure
    if (response.status === 200 && response.data) {
      // Check if it's a streaming response (SSE format)
      if (typeof response.data === 'string' && response.data.includes('data: {')) {
        console.log('[TEST] ✅ API test completed successfully with streaming response from mock provider.');
        
        // Optionally parse some streaming chunks for validation
        const lines = response.data.split('\n');
        const dataLines = lines.filter(line => line.startsWith('data: {'));
        console.log('[TEST] Received', dataLines.length, 'streaming chunks');
        
        if (dataLines.length > 0) {
          try {
            const firstChunk = JSON.parse(dataLines[0].substring(6)); // Remove "data: " prefix
            if (firstChunk.object === 'chat.completion.chunk' && firstChunk.choices) {
              console.log('[TEST] ✅ Streaming format validation passed');
            }
          } catch (e) {
            console.log('[TEST] ⚠️  Could not parse first chunk, but streaming response received');
          }
        }
      } 
      // Check for non-streaming response structure
      else if (response.data.choices && 
               Array.isArray(response.data.choices) && 
               response.data.choices.length > 0 &&
               response.data.choices[0].message &&
               typeof response.data.choices[0].message.content === 'string' &&
               response.data.usage &&
               typeof response.data.usage.total_tokens === 'number') {
        console.log('[TEST] ✅ API test completed successfully with non-streaming response.');
      } else {
        console.error('[TEST] ❌ API test failed: Unexpected response structure or status code.');
        console.error('[TEST] Expected either streaming SSE format or OpenAI-compatible structure');
        process.exit(1);
      }
    } else {
      console.error('[TEST] ❌ API test failed: Non-200 status code or missing response data.');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('[TEST] --- API Test Failed ---');
    if (axios.isAxiosError(error)) {
      console.error('[TEST] Error making API request:', error.message);
      if (error.response) {
        console.error('[TEST] Status Code:', error.response.status);
        console.error('[TEST] Response Data:', error.response.data);
      } else if (error.code === 'ECONNREFUSED') {
        console.error(`[TEST] Connection refused - is the API server running on ${baseUrl}?`);
      }
    } else {
      console.error('[TEST] An unexpected error occurred:', error);
    }
    console.error('[TEST] -----------------------');
    process.exit(1);
  } finally {
    // Restore original configuration
    restoreProviderConfig();
  }
}

testApiWithMockProvider();
