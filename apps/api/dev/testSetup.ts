import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const testDataRoot = path.join(apiRoot, '.tmp', 'test-data');
const DEFAULT_TEST_MODELS_CREATED_AT = 1_700_000_000;

export const DEFAULT_TEST_API_KEY = 'test-key-for-automated-testing-0123456789abcdef';
const LEGACY_TEST_API_KEY = 'test-key-for-mock-provider';

function resolveTestDataPath(envVarName: string, defaultPath: string): string {
  const override = process.env[envVarName];
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(apiRoot, override.trim());
  }
  return defaultPath;
}

// Create a test configuration that sets up providers.json to use the mock provider
export function setupMockProviderConfig(mode: 'openai' | 'anthropic' = 'openai') {
  const mockPort = Number(process.env.MOCK_PROVIDER_PORT || '3001');
  const testApiKey = process.env.TEST_API_KEY || DEFAULT_TEST_API_KEY;
  const hashSecret = process.env.API_KEY_HASH_SECRET || 'anygpt-api';
  const hashIterations = Number(process.env.API_KEY_HASH_ITERATIONS || '20000');
  const hashKeylen = Number(process.env.API_KEY_HASH_KEYLEN || '32');
  const hashDigest = 'sha256';
  const providersFilePath = resolveTestDataPath('API_PROVIDERS_FILE', path.join(testDataRoot, 'providers.json'));
  const keysFilePath = resolveTestDataPath('API_KEYS_FILE', path.join(testDataRoot, 'keys.json'));
  const modelsFilePath = resolveTestDataPath('API_MODELS_FILE', path.join(testDataRoot, 'models.json'));
  const backupProvidersPath = `${providersFilePath}.backup`;
  const backupKeysPath = `${keysFilePath}.backup`;
  const backupModelsPath = `${modelsFilePath}.backup`;

  const providerId = mode === 'anthropic' ? 'claude-mock' : 'openai-mock';
  const primaryModelId = mode === 'anthropic' ? 'claude-3-5-sonnet' : 'gpt-3.5-turbo';
  const secondaryModelId = mode === 'anthropic' ? 'claude-3-7-sonnet' : 'gpt-5.4';
  const genericOpenAiCompatibleProviderId = 'acme-compatible-mock';
  const genericOpenAiCompatibleModelId = 'text-pro-1';
  const providerUrl = mode === 'anthropic'
    ? `http://localhost:${mockPort}/v1/messages`
    : `http://localhost:${mockPort}/v1/chat/completions`;

  const mockProvider = {
    id: providerId,
    apiKey: 'mock-api-key-for-testing',
    provider_url: providerUrl,
    streamingCompatible: true,
    models: {
      [primaryModelId]: {
        id: primaryModelId,
        token_generation_speed: 50,
        response_times: [],
        errors: 0,
        consecutive_errors: 0,
        avg_response_time: null,
        avg_provider_latency: null,
        avg_token_speed: null
      },
      [secondaryModelId]: {
        id: secondaryModelId,
        token_generation_speed: 50,
        response_times: [],
        errors: 0,
        consecutive_errors: 0,
        avg_response_time: null,
        avg_provider_latency: null,
        avg_token_speed: null
      }
    },
    avg_response_time: null,
    avg_provider_latency: null,
    errors: 0,
    provider_score: mode === 'anthropic' ? 95 : 100,
    disabled: false
  };

  const additionalProviders = mode === 'openai'
    ? [
        {
          id: genericOpenAiCompatibleProviderId,
          apiKey: 'mock-api-key-for-testing',
          provider_url: providerUrl,
          native_protocol: 'openai',
          streamingCompatible: true,
          models: {
            [genericOpenAiCompatibleModelId]: {
              id: genericOpenAiCompatibleModelId,
              token_generation_speed: 50,
              response_times: [],
              errors: 0,
              consecutive_errors: 0,
              avg_response_time: null,
              avg_provider_latency: null,
              avg_token_speed: null
            }
          },
          avg_response_time: null,
          avg_provider_latency: null,
          errors: 0,
          provider_score: 90,
          disabled: false
        }
      ]
    : [];

  const testUserKey = {
    userId: 'test-user',
    tokenUsage: 0,
    requestCount: 0,
    role: 'user' as const,
    tier: 'enterprise'
  };

  const created = DEFAULT_TEST_MODELS_CREATED_AT;
  const testModels = {
    object: 'list',
    data: [
      {
        id: primaryModelId,
        object: 'model',
        created,
        owned_by: providerId,
        providers: 1,
        throughput: 50,
        capabilities: ['text', 'tool_calling'],
      },
      {
        id: secondaryModelId,
        object: 'model',
        created,
        owned_by: providerId,
        providers: 1,
        throughput: 50,
        capabilities: ['text', 'tool_calling'],
      },
      ...(mode === 'openai'
        ? [
            {
              id: genericOpenAiCompatibleModelId,
              object: 'model',
              created,
              owned_by: genericOpenAiCompatibleProviderId,
              providers: 1,
              throughput: 50,
              capabilities: ['text', 'tool_calling'],
            },
          ]
        : []),
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
  fs.writeFileSync(providersFilePath, JSON.stringify([mockProvider, ...additionalProviders], null, 2));
  console.log('[TEST-SETUP] Created mock provider configuration');

  fs.writeFileSync(modelsFilePath, JSON.stringify(testModels, null, 2));
  console.log('[TEST-SETUP] Created isolated test models.json');

  // Add test API key to keys.json
  const deriveKeyHash = (value: string) => crypto.pbkdf2Sync(
    value,
    hashSecret,
    hashIterations,
    hashKeylen,
    hashDigest
  ).toString('hex');

  const updatedKeys: Record<string, typeof testUserKey> = {};

  if (!updatedKeys[testApiKey]) {
    updatedKeys[testApiKey] = testUserKey;
  }

  const hashedApiKey = deriveKeyHash(testApiKey);
  if (!updatedKeys[hashedApiKey]) {
    updatedKeys[hashedApiKey] = testUserKey;
  }

  if (!updatedKeys[LEGACY_TEST_API_KEY]) {
    updatedKeys[LEGACY_TEST_API_KEY] = testUserKey;
  }

  const hashedFallbackKey = deriveKeyHash(LEGACY_TEST_API_KEY);
  if (!updatedKeys[hashedFallbackKey]) {
    updatedKeys[hashedFallbackKey] = testUserKey;
  }

  fs.writeFileSync(keysFilePath, JSON.stringify(updatedKeys, null, 2));
  console.log('[TEST-SETUP] Added test API key to keys.json');
}

function restoreOrRemoveGeneratedFile(filePath: string, backupPath: string, label: string): void {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    console.log(`[TEST-CLEANUP] Restored original ${label}`);
    return;
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`[TEST-CLEANUP] Removed generated ${label}`);
  }
}

function removeDirectoryIfEmpty(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  if (fs.readdirSync(dirPath).length > 0) return;
  fs.rmdirSync(dirPath);
}

export function restoreProviderConfig() {
  const providersFilePath = resolveTestDataPath('API_PROVIDERS_FILE', path.join(testDataRoot, 'providers.json'));
  const keysFilePath = resolveTestDataPath('API_KEYS_FILE', path.join(testDataRoot, 'keys.json'));
  const modelsFilePath = resolveTestDataPath('API_MODELS_FILE', path.join(testDataRoot, 'models.json'));
  const backupProvidersPath = `${providersFilePath}.backup`;
  const backupKeysPath = `${keysFilePath}.backup`;
  const backupModelsPath = `${modelsFilePath}.backup`;

  restoreOrRemoveGeneratedFile(providersFilePath, backupProvidersPath, 'providers.json');
  restoreOrRemoveGeneratedFile(keysFilePath, backupKeysPath, 'keys.json');
  restoreOrRemoveGeneratedFile(modelsFilePath, backupModelsPath, 'models.json');
  removeDirectoryIfEmpty(testDataRoot);
}
