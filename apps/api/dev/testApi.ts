import axios from 'axios';
import { config } from 'dotenv';

// Load environment variables (optional, server should have them)
config();

async function testApiGemini() {
  const apiUrl = 'http://localhost:3000/v1/chat/completions';
  // Use a model ID that your API maps to the provider you want to test
  // Check your API's model configuration (e.g., models.json or routermodels.json)
  // Assuming 'openai-nexeon' is the provider and it uses a model ID like 'gpt-3.5-turbo' internally
  // Or if 'openai-nexeon' IS the model ID itself in your router configuration
  const modelId = 'gpt-3.5-turbo'; // Use the ID that your router maps to the correct provider/model
  const testPrompt = 'Write a short haiku about APIs.';
  // Use an API key that is valid for your proxy/router API
  const apiKey = 'ad9970421fe07447bf011f78a88d72af2e7465df65d27844feeb2df9aa5f6772'; // Ensure this key is registered in your API's keys.json or equivalent

  console.log(`Testing API endpoint: ${apiUrl}`);
  console.log(`Using model: ${modelId}`); // Updated log

  try {
    const requestBody = {
      model: modelId, // Use the model ID your router expects
      messages: [
        { role: 'user', content: testPrompt }
      ],
      // stream: false // Ensure streaming is off
    };

    console.log('Sending request...');
    const startTime = Date.now();
    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // Use the API key for your router
      }
    });
    const latency = Date.now() - startTime;

    console.log('[TEST] --- API Test Result ---'); // Added prefix for clarity
    console.log('[TEST] Status Code:', response.status);
    console.log('[TEST] Latency:', latency, 'ms');
    console.log('[TEST] Response Data:');
    console.log(JSON.stringify(response.data, null, 2)); // Pretty print the JSON response
    console.log('[TEST] -----------------------'); // Added prefix for clarity

    // *** Updated success check ***
    // Check for the actual response structure received based on logs
    if (response.status === 200 && response.data && typeof response.data.response === 'string' && typeof response.data.latency === 'number' && typeof response.data.tokenUsage === 'number') {
      console.log('[TEST] API test completed successfully.');
    } else {
      console.error('[TEST] API test failed: Unexpected response structure or status code.');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('[TEST] --- API Test Failed ---'); // Added prefix for clarity
    if (axios.isAxiosError(error)) {
      console.error('[TEST] Error making API request:', error.message);
      if (error.response) {
        console.error('[TEST] Status Code:', error.response.status);
        console.error('[TEST] Response Data:', error.response.data);
      }
    } else {
      console.error('[TEST] An unexpected error occurred:', error);
    }
    console.error('[TEST] -----------------------'); // Added prefix for clarity
    process.exit(1);
  }
}

testApiGemini();
