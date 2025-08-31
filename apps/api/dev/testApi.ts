import axios from 'axios';
import { config } from 'dotenv';
import { setupMockProviderConfig, restoreProviderConfig } from './testSetup.js';

// Load environment variables (optional, server should have them)
config();

async function testApiWithMockProvider() {
  // Setup mock provider configuration
  setupMockProviderConfig();
  
  const apiUrl = 'http://localhost:3000/v1/chat/completions';
  const modelId = 'gpt-3.5-turbo';
  const testPrompt = 'Write a short haiku about APIs.';
  // Use an existing admin API key that we know is valid
  const apiKey = 'f94b06121fcae0383f1284f4609a9783b2a60f1277b6670ec6edde62739edb35';

  console.log(`[TEST] Testing API endpoint: ${apiUrl}`);
  console.log(`[TEST] Using model: ${modelId}`);
  console.log(`[TEST] Mock provider should be configured for this test`);

  try {
    const requestBody = {
      model: modelId,
      messages: [
        { role: 'user', content: testPrompt }
      ]
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

    // Check for OpenAI-compatible response structure
    if (response.status === 200 && 
        response.data && 
        response.data.choices && 
        Array.isArray(response.data.choices) && 
        response.data.choices.length > 0 &&
        response.data.choices[0].message &&
        typeof response.data.choices[0].message.content === 'string' &&
        response.data.usage &&
        typeof response.data.usage.total_tokens === 'number') {
      console.log('[TEST] ✅ API test completed successfully with mock provider.');
    } else {
      console.error('[TEST] ❌ API test failed: Unexpected response structure or status code.');
      console.error('[TEST] Expected OpenAI-compatible structure with choices[0].message.content and usage.total_tokens');
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
        console.error('[TEST] Connection refused - is the API server running on localhost:3000?');
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
