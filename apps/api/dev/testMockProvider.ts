import axios from 'axios';

async function testMockProvider() {
  const mockUrl = 'http://localhost:3001';
  
  console.log('[MOCK-TEST] Testing mock provider endpoints...');
  
  try {
    // Test health endpoint
    console.log('\n[MOCK-TEST] Testing health endpoint...');
    const healthResponse = await axios.get(`${mockUrl}/health`, { timeout: 5000 });
    console.log('[MOCK-TEST] Health check response:', healthResponse.data);
    
    // Test models endpoint
    console.log('\n[MOCK-TEST] Testing models endpoint...');
    const modelsResponse = await axios.get(`${mockUrl}/v1/models`, { timeout: 5000 });
    console.log('[MOCK-TEST] Models response:', JSON.stringify(modelsResponse.data, null, 2));
    
    // Test configuration endpoints
    console.log('\n[MOCK-TEST] Testing configuration endpoints...');
    
    // Get current configuration
    const configResponse = await axios.get(`${mockUrl}/mock/config`, { timeout: 5000 });
    console.log('[MOCK-TEST] Current configuration:', JSON.stringify(configResponse.data, null, 2));
    
    // Test configuration update - increase error rate for testing
    console.log('\n[MOCK-TEST] Testing configuration update (increasing error rate)...');
    const updateResponse = await axios.post(`${mockUrl}/mock/config`, {
      errorRate: 0.3, // 30% error rate
      baseDelay: 200,
      delayVariance: 100,
      enableLogs: true
    }, { 
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000 
    });
    console.log('[MOCK-TEST] Configuration update response:', updateResponse.data);
    
    // Test chat completions with higher error rate
    console.log('\n[MOCK-TEST] Testing chat completions with higher error rate...');
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < 5; i++) {
      try {
        const chatResponse = await axios.post(`${mockUrl}/v1/chat/completions`, {
          model: 'mock-gpt-3.5-turbo',
          messages: [
            { role: 'user', content: `Test request ${i + 1}: Write a haiku about testing.` }
          ]
        }, { 
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000 
        });
        
        successCount++;
        console.log(`[MOCK-TEST] Request ${i + 1} succeeded in ${chatResponse.headers['x-response-time'] || 'unknown'}ms`);
      } catch (error: any) {
        errorCount++;
        console.log(`[MOCK-TEST] Request ${i + 1} failed: ${error.response?.status || 'unknown'} - ${error.response?.data?.message || error.message}`);
      }
    }
    
    console.log(`\n[MOCK-TEST] Results with 30% error rate: ${successCount} successes, ${errorCount} errors`);
    
    // Reset configuration to normal
    console.log('\n[MOCK-TEST] Resetting configuration to normal...');
    await axios.post(`${mockUrl}/mock/reset`, {}, { timeout: 5000 });
    
    // Test one final request with normal settings
    console.log('\n[MOCK-TEST] Testing final request with reset configuration...');
    const finalResponse = await axios.post(`${mockUrl}/v1/chat/completions`, {
      model: 'mock-gpt-3.5-turbo',
      messages: [
        { role: 'user', content: 'Final test: Write a short haiku about testing.' }
      ]
    }, { 
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000 
    });
    
    console.log('[MOCK-TEST] Final response status:', finalResponse.status);
    
    // Validate response structure
    const data = finalResponse.data;
    if (data.choices && data.choices[0] && data.choices[0].message && data.usage) {
      console.log('\n[MOCK-TEST] ✅ Mock provider is working correctly!');
      console.log('[MOCK-TEST] ✅ Configuration endpoints are functional!');
      console.log('[MOCK-TEST] ✅ Response contains required OpenAI-compatible structure');
    } else {
      console.error('[MOCK-TEST] ❌ Mock provider response structure is invalid');
      process.exit(1);
    }
    
  } catch (error: any) {
    console.error('[MOCK-TEST] ❌ Mock provider test failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('[MOCK-TEST] Connection refused - is the mock provider running on localhost:3001?');
    }
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (process.argv[1].includes('testMockProvider.ts')) {
  testMockProvider();
}

export { testMockProvider };