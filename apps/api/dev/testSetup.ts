import fs from 'fs';
import path from 'path';

// Create a test configuration that sets up providers.json to use the mock provider
export function setupMockProviderConfig() {
  const providersFilePath = path.resolve('./providers.json');
  const keysFilePath = path.resolve('./keys.json');
  const backupProvidersPath = path.resolve('./providers.json.backup');
  const backupKeysPath = path.resolve('./keys.json.backup');
  
  // Try to preserve existing response times and stats
  let existingProvider = null;
  if (fs.existsSync(providersFilePath)) {
    try {
      const existingProviders = JSON.parse(fs.readFileSync(providersFilePath, 'utf8'));
      existingProvider = existingProviders.find((p: any) => p.id === 'openai-mock');
    } catch (error) {
      console.log('[TEST-SETUP] Could not parse existing providers.json, starting fresh');
    }
  }

  const mockProvider = {
    id: 'openai-mock', // Use existing provider ID to override it
    apiKey: 'mock-api-key-for-testing',
    provider_url: 'http://localhost:3001/v1/chat/completions', // Point to our mock
    models: {
      'gpt-3.5-turbo': {
        id: 'gpt-3.5-turbo',
        token_generation_speed: existingProvider?.models?.['gpt-3.5-turbo']?.token_generation_speed || 50,
        response_times: existingProvider?.models?.['gpt-3.5-turbo']?.response_times || [],
        errors: existingProvider?.models?.['gpt-3.5-turbo']?.errors || 0,
        consecutive_errors: existingProvider?.models?.['gpt-3.5-turbo']?.consecutive_errors || 0,
        avg_response_time: existingProvider?.models?.['gpt-3.5-turbo']?.avg_response_time || null,
        avg_provider_latency: existingProvider?.models?.['gpt-3.5-turbo']?.avg_provider_latency || null,
        avg_token_speed: existingProvider?.models?.['gpt-3.5-turbo']?.avg_token_speed || null
      }
    },
    avg_response_time: existingProvider?.avg_response_time || null,
    avg_provider_latency: existingProvider?.avg_provider_latency || null,
    errors: existingProvider?.errors || 0,
    provider_score: existingProvider?.provider_score || null,
    disabled: false
  };

  const testUserKey = {
    userId: 'test-user',
    tokenUsage: 0,
    role: 'user' as const,
    tier: 'enterprise'
  };

  // Backup existing files if they exist
  if (fs.existsSync(providersFilePath)) {
    fs.copyFileSync(providersFilePath, backupProvidersPath);
    console.log('[TEST-SETUP] Backed up existing providers.json');
  }
  
  if (fs.existsSync(keysFilePath)) {
    fs.copyFileSync(keysFilePath, backupKeysPath);
    console.log('[TEST-SETUP] Backed up existing keys.json');
  }

  // Write mock provider configuration
  fs.writeFileSync(providersFilePath, JSON.stringify([mockProvider], null, 2));
  console.log('[TEST-SETUP] Created mock provider configuration');

  // Add test API key to keys.json
  let existingKeys = {};
  if (fs.existsSync(keysFilePath)) {
    try {
      existingKeys = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
    } catch (error) {
      console.log('[TEST-SETUP] Could not parse existing keys.json, starting fresh');
    }
  }

  const updatedKeys = {
    ...existingKeys,
    'test-key-for-mock-provider': testUserKey
  };

  fs.writeFileSync(keysFilePath, JSON.stringify(updatedKeys, null, 2));
  console.log('[TEST-SETUP] Added test API key to keys.json');
}

export function restoreProviderConfig() {
  const providersFilePath = path.resolve('./providers.json');
  const keysFilePath = path.resolve('./keys.json');
  const backupProvidersPath = path.resolve('./providers.json.backup');
  const backupKeysPath = path.resolve('./keys.json.backup');

  // Preserve response times and stats from the test run
  let updatedProviderData = null;
  if (fs.existsSync(providersFilePath)) {
    try {
      const currentProviders = JSON.parse(fs.readFileSync(providersFilePath, 'utf8'));
      updatedProviderData = currentProviders.find((p: any) => p.id === 'openai-mock');
    } catch (error) {
      console.log('[TEST-CLEANUP] Could not parse current providers.json');
    }
  }

  if (fs.existsSync(backupProvidersPath)) {
    // Read the backup
    const backupProviders = JSON.parse(fs.readFileSync(backupProvidersPath, 'utf8'));
    
    // Find the existing provider in backup and merge the new response times
    if (updatedProviderData) {
      const existingProviderIndex = backupProviders.findIndex((p: any) => p.id === 'openai-mock');
      if (existingProviderIndex >= 0) {
        // Merge response times and updated stats
        const existingProvider = backupProviders[existingProviderIndex];
        if (existingProvider.models && existingProvider.models['gpt-3.5-turbo'] && 
            updatedProviderData.models && updatedProviderData.models['gpt-3.5-turbo']) {
          
          // Keep all the new response times, errors, and computed stats
          existingProvider.models['gpt-3.5-turbo'].response_times = 
            updatedProviderData.models['gpt-3.5-turbo'].response_times || existingProvider.models['gpt-3.5-turbo'].response_times;
          existingProvider.models['gpt-3.5-turbo'].errors = 
            updatedProviderData.models['gpt-3.5-turbo'].errors;
          existingProvider.models['gpt-3.5-turbo'].consecutive_errors = 
            updatedProviderData.models['gpt-3.5-turbo'].consecutive_errors;
          existingProvider.models['gpt-3.5-turbo'].avg_response_time = 
            updatedProviderData.models['gpt-3.5-turbo'].avg_response_time;
          existingProvider.models['gpt-3.5-turbo'].avg_provider_latency = 
            updatedProviderData.models['gpt-3.5-turbo'].avg_provider_latency;
          existingProvider.models['gpt-3.5-turbo'].avg_token_speed = 
            updatedProviderData.models['gpt-3.5-turbo'].avg_token_speed;
          
          // Update provider-level stats too
          existingProvider.avg_response_time = updatedProviderData.avg_response_time;
          existingProvider.avg_provider_latency = updatedProviderData.avg_provider_latency;
          existingProvider.errors = updatedProviderData.errors;
          existingProvider.provider_score = updatedProviderData.provider_score;
          
          console.log('[TEST-CLEANUP] Merged new response times and stats into original provider data');
        }
      }
    }
    
    // Write the merged data back
    fs.writeFileSync(providersFilePath, JSON.stringify(backupProviders, null, 2));
    fs.unlinkSync(backupProvidersPath);
    console.log('[TEST-CLEANUP] Restored providers.json with updated response times');
  } else {
    // If no backup exists, keep the current file (which should have the new response times)
    console.log('[TEST-CLEANUP] No backup found, keeping current providers.json with new response times');
  }

  if (fs.existsSync(backupKeysPath)) {
    fs.copyFileSync(backupKeysPath, keysFilePath);
    fs.unlinkSync(backupKeysPath);
    console.log('[TEST-CLEANUP] Restored original keys.json');
  }
}