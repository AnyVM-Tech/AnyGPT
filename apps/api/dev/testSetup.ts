import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');

function resolveTestDataPath(envVarName: string, defaultPath: string): string {
  const override = process.env[envVarName];
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(apiRoot, override.trim());
  }
  return defaultPath;
}

// Create a test configuration that sets up providers.json to use the mock provider
export function setupMockProviderConfig() {
  const mockPort = Number(process.env.MOCK_PROVIDER_PORT || '3001');
  const testApiKey = process.env.TEST_API_KEY || 'test-key-for-mock-provider';
  const hashSecret = process.env.API_KEY_HASH_SECRET || 'anygpt-api';
  const hashIterations = Number(process.env.API_KEY_HASH_ITERATIONS || '20000');
  const hashKeylen = Number(process.env.API_KEY_HASH_KEYLEN || '32');
  const hashDigest = 'sha256';
  const providersFilePath = resolveTestDataPath('API_PROVIDERS_FILE', path.join(apiRoot, 'providers.json'));
  const keysFilePath = resolveTestDataPath('API_KEYS_FILE', path.join(apiRoot, 'keys.json'));
  const modelsFilePath = resolveTestDataPath('API_MODELS_FILE', path.join(apiRoot, 'models.json'));
  const backupProvidersPath = `${providersFilePath}.backup`;
  const backupKeysPath = `${keysFilePath}.backup`;
  const backupModelsPath = `${modelsFilePath}.backup`;
  
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
    provider_url: `http://localhost:${mockPort}/v1/chat/completions`, // Point to our mock
    streamingCompatible: true, // Mock provider supports streaming
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
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        token_generation_speed: existingProvider?.models?.['gpt-5.4']?.token_generation_speed || 50,
        response_times: existingProvider?.models?.['gpt-5.4']?.response_times || [],
        errors: existingProvider?.models?.['gpt-5.4']?.errors || 0,
        consecutive_errors: existingProvider?.models?.['gpt-5.4']?.consecutive_errors || 0,
        avg_response_time: existingProvider?.models?.['gpt-5.4']?.avg_response_time || null,
        avg_provider_latency: existingProvider?.models?.['gpt-5.4']?.avg_provider_latency || null,
        avg_token_speed: existingProvider?.models?.['gpt-5.4']?.avg_token_speed || null
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
    requestCount: 0,
    role: 'user' as const,
    tier: 'enterprise'
  };

  const created = Math.floor(Date.now() / 1000);
  const testModels = {
    object: 'list',
    data: [
      {
        id: 'gpt-3.5-turbo',
        object: 'model',
        created,
        owned_by: 'openai-mock',
        providers: 1,
        throughput: 50,
        capabilities: ['text', 'tool_calling'],
      },
      {
        id: 'gpt-5.4',
        object: 'model',
        created,
        owned_by: 'openai-mock',
        providers: 1,
        throughput: 50,
        capabilities: ['text', 'tool_calling'],
      },
    ],
  };

  fs.mkdirSync(path.dirname(providersFilePath), { recursive: true });
  fs.mkdirSync(path.dirname(keysFilePath), { recursive: true });
  fs.mkdirSync(path.dirname(modelsFilePath), { recursive: true });

  // Backup existing files if they exist
  if (fs.existsSync(providersFilePath)) {
    fs.copyFileSync(providersFilePath, backupProvidersPath);
    console.log('[TEST-SETUP] Backed up existing providers.json');
  }
  
  if (fs.existsSync(keysFilePath)) {
    fs.copyFileSync(keysFilePath, backupKeysPath);
    console.log('[TEST-SETUP] Backed up existing keys.json');
  }

  if (fs.existsSync(modelsFilePath)) {
    fs.copyFileSync(modelsFilePath, backupModelsPath);
    console.log('[TEST-SETUP] Backed up existing models.json');
  }

  // Write mock provider configuration
  fs.writeFileSync(providersFilePath, JSON.stringify([mockProvider], null, 2));
  console.log('[TEST-SETUP] Created mock provider configuration');

  fs.writeFileSync(modelsFilePath, JSON.stringify(testModels, null, 2));
  console.log('[TEST-SETUP] Created isolated test models.json');

  // Add test API key to keys.json
  let existingKeys: Record<string, typeof testUserKey> = {};
  if (fs.existsSync(keysFilePath)) {
    try {
      existingKeys = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
    } catch (error) {
      console.log('[TEST-SETUP] Could not parse existing keys.json, starting fresh');
    }
  }

  const deriveKeyHash = (value: string) => crypto.pbkdf2Sync(
    value,
    hashSecret,
    hashIterations,
    hashKeylen,
    hashDigest
  ).toString('hex');

  const updatedKeys: Record<string, typeof testUserKey> = {
    ...existingKeys,
  };

  if (!updatedKeys[testApiKey]) {
    updatedKeys[testApiKey] = testUserKey;
  }

  const hashedApiKey = deriveKeyHash(testApiKey);
  if (!updatedKeys[hashedApiKey]) {
    updatedKeys[hashedApiKey] = testUserKey;
  }

  if (!updatedKeys['test-key-for-mock-provider']) {
    updatedKeys['test-key-for-mock-provider'] = testUserKey;
  }

  const hashedFallbackKey = deriveKeyHash('test-key-for-mock-provider');
  if (!updatedKeys[hashedFallbackKey]) {
    updatedKeys[hashedFallbackKey] = testUserKey;
  }

  fs.writeFileSync(keysFilePath, JSON.stringify(updatedKeys, null, 2));
  console.log('[TEST-SETUP] Added test API key to keys.json');
}

export function restoreProviderConfig() {
  const providersFilePath = resolveTestDataPath('API_PROVIDERS_FILE', path.join(apiRoot, 'providers.json'));
  const keysFilePath = resolveTestDataPath('API_KEYS_FILE', path.join(apiRoot, 'keys.json'));
  const modelsFilePath = resolveTestDataPath('API_MODELS_FILE', path.join(apiRoot, 'models.json'));
  const backupProvidersPath = `${providersFilePath}.backup`;
  const backupKeysPath = `${keysFilePath}.backup`;
  const backupModelsPath = `${modelsFilePath}.backup`;

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

  if (fs.existsSync(backupModelsPath)) {
    fs.copyFileSync(backupModelsPath, modelsFilePath);
    fs.unlinkSync(backupModelsPath);
    console.log('[TEST-CLEANUP] Restored original models.json');
  }
}
