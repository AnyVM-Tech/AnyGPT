import crypto from 'crypto';
// Remove direct fs import if no longer needed
// import fs from 'fs';
// Import the singleton DataManager instance
import { dataManager, ModelsFileStructure } from './dataManager.js';
// Import tiers data directly (static configuration)
import tiersData from '../tiers.json' with { type: 'json' };
import { logger } from './logger.js';
import { hashToken } from './redaction.js';

// --- Per-model pricing cache for estimatedCost ---
interface ModelPricing { input: number; output: number; }
let _pricingCache: Map<string, ModelPricing> = new Map();
let _avgBlendedRate: number = 0;
let _pricingLastUpdated = 0;
const PRICING_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 minutes

async function refreshPricingCache(): Promise<void> {
  const now = Date.now();
  if (_pricingCache.size > 0 && (now - _pricingLastUpdated) < PRICING_REFRESH_MS) return;
  try {
    const modelsFile = await dataManager.load<ModelsFileStructure>('models');
    const data = modelsFile?.data || [];
    const next = new Map<string, ModelPricing>();
    const blendedRates: number[] = [];
    for (const m of data) {
      const p = (m as any).pricing;
      if (!p) continue;
      const inp = typeof p.input === 'number' ? p.input : 0;
      const out = typeof p.output === 'number' ? p.output : 0;
      if (inp > 0 || out > 0) {
        next.set(m.id, { input: inp, output: out });
        blendedRates.push((inp + out) / 2);
      }
    }
    if (next.size > 0) {
      _pricingCache = next;
      _avgBlendedRate = blendedRates.reduce((a, b) => a + b, 0) / blendedRates.length;
      _pricingLastUpdated = now;
    }
  } catch {
    // Keep previous cache if models aren't available
  }
}

function calculateRequestCost(
  totalTokens: number,
  modelId?: string,
  promptTokens?: number,
  completionTokens?: number
): number {
  if (modelId && _pricingCache.has(modelId)) {
    const pricing = _pricingCache.get(modelId)!;
    const pTokens = typeof promptTokens === 'number' ? promptTokens : totalTokens;
    const cTokens = typeof completionTokens === 'number' ? completionTokens : 0;
    // pricing.input and pricing.output are $/M tokens
    return (pTokens * pricing.input + cTokens * pricing.output) / 1_000_000;
  }
  // Fallback: blended average rate
  if (_avgBlendedRate > 0) {
    return (totalTokens * _avgBlendedRate) / 1_000_000;
  }
  return 0;
}

// --- Type Definitions --- 
// Export interfaces for use in other modules
export interface TierData {
  rps: number;
  rpm: number;
  rpd: number;
  max_tokens: number | null; 
  min_provider_score: number | null; 
  max_provider_score: number | null; 
}
type TiersFile = Record<string, TierData>;
const tiers: TiersFile = tiersData;

export interface UserData {
  userId: string;
  tokenUsage: number;
  requestCount: number;
  role: 'admin' | 'user';
  tier: keyof TiersFile; // Use keyof TiersFile for better type safety
  estimatedCost?: number;
}
// Define KeysFile structure locally or import if shared
export interface KeysFile { [apiKey: string]: UserData; }

// --- Functions using DataManager --- 

export async function generateUserApiKey(userId: string, role: 'admin' | 'user' = 'user', tier: keyof TiersFile = 'free'): Promise<string> { 
  if (!userId) throw new Error('User ID required.');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const currentKeys = await dataManager.load<KeysFile>('keys'); 

  if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has an API key.`); // Keep this specific error
  }

  // Validate provided tier or default
  const finalTier = tiers[tier] ? tier : 'free';
  if (!tiers[finalTier]) {
      // This case should ideally not be hit if 'free' tier is always present, but good for safety
      console.warn(`Tier '${tier}' not found, and default 'free' tier also missing. Falling back to first available tier or erroring.`);
      // Attempt to find any available tier if 'free' is somehow missing
      const availableTiers = Object.keys(tiers) as (keyof TiersFile)[];
      if(availableTiers.length === 0) throw new Error("Configuration error: No tiers defined (including 'free').");
      // If you want to be super robust, you might pick the first available tier, but it's better if 'free' exists.
      // For now, this indicates a critical config issue if 'free' is not found when 'tier' is also invalid.
      if (finalTier === 'free') throw new Error("Configuration error: Default 'free' tier is missing in tiers.json.");
      // If a custom tier was provided but not found, and 'free' is missing, this is also an issue.
  }

  currentKeys[apiKey] = { userId, tokenUsage: 0, requestCount: 0, role: role, tier: finalTier };
  await dataManager.save<KeysFile>('keys', currentKeys); 
  console.log(`Generated key for ${userId} with role: ${role} and tier: ${finalTier}.`); 
  return apiKey;
}

export async function generateAdminApiKey(userId: string): Promise<string> { // Made async
   if (!userId) throw new Error('User ID required.');
   const apiKey = crypto.randomBytes(32).toString('hex');
   const currentKeys = await dataManager.load<KeysFile>('keys');

   if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has API key.`);
  }
   const adminTier: keyof TiersFile = tiers.enterprise ? 'enterprise' : (tiers.free ? 'free' : ''); 
   if (!adminTier) throw new Error("Config error: No admin tier found.");

  currentKeys[apiKey] = { userId, tokenUsage: 0, requestCount: 0, role: 'admin', tier: adminTier };
  await dataManager.save<KeysFile>('keys', currentKeys); 
  console.log(`Generated admin key for ${userId}.`);
  return apiKey;
}

// Becomes async due to dataManager.load
export async function validateApiKeyAndUsage(apiKey: string): Promise<{ valid: boolean; userData?: UserData; tierLimits?: TierData, error?: string }> {
  const apiKeyHash = hashToken(apiKey).slice(0, 12);
  logger.debug(`[validateApiKeyAndUsage] Validating API key hash: ${apiKeyHash}`);
  const currentKeys = await dataManager.load<KeysFile>('keys'); 
  logger.debug(`[validateApiKeyAndUsage] Loaded keys count: ${Object.keys(currentKeys).length}`);
  const userData = currentKeys[apiKey];
  logger.debug(`[validateApiKeyAndUsage] User data for API key hash: ${apiKeyHash} => ${userData ? 'found' : 'missing'}`);

  if (!userData) {
      logger.warn(`[validateApiKeyAndUsage] API key not found (hash: ${apiKeyHash})`);
      return { valid: false, error: 'API key not found.' };
  }

    if (typeof userData.tokenUsage !== 'number' || Number.isNaN(userData.tokenUsage) || userData.tokenUsage < 0) {
      userData.tokenUsage = 0;
    }
    if (typeof userData.requestCount !== 'number' || Number.isNaN(userData.requestCount) || userData.requestCount < 0) {
      userData.requestCount = 0;
    }

  const tierLimits = tiers[userData.tier]; // tiers is static import
  logger.debug(`[validateApiKeyAndUsage] Tier limits resolved for API key hash: ${apiKeyHash}`);

  if (!tierLimits) {
      const errorMsg = `Invalid tier ('${userData.tier}') for key ${apiKey.substring(0,6)}...`;
      logger.warn(`[validateApiKeyAndUsage] ${errorMsg}`);
      return { valid: false, error: errorMsg, userData };
  }

  if (tierLimits.max_tokens !== null && userData.tokenUsage >= tierLimits.max_tokens) {
      const errorMsg = `Token limit (${tierLimits.max_tokens}) reached for key ${apiKey.substring(0,6)}...`;
      logger.warn(`[validateApiKeyAndUsage] ${errorMsg}`);
      return { valid: false, error: errorMsg, userData, tierLimits };
  }

  logger.debug(`[validateApiKeyAndUsage] Validation successful for API key hash: ${apiKeyHash}`);
  return { valid: true, userData, tierLimits }; 
}

// Becomes async due to dataManager.load
export async function getTierLimits(apiKey: string): Promise<TierData | null> {
   const keys = await dataManager.load<KeysFile>('keys');
   const userData = keys[apiKey];
   if (!userData) { return null; }
   const limits = tiers[userData.tier]; // tiers is static import
   if (!limits) { return null; }
   return limits;
}

// Parse and validate request body for chat/completions; caller supplies the already-parsed body.
export function extractMessageFromRequestBody(requestBody: any): { messages: { role: string; content: any }[]; model: string; max_tokens?: number } { 
  try {
    if (!requestBody || typeof requestBody !== 'object') throw new Error('Invalid body.');
    if (!Array.isArray(requestBody.messages)) throw new Error('Invalid messages format.');
    if (typeof requestBody.model !== 'string' || !requestBody.model) {
       throw new Error('model parameter is required.');
    }

    // Basic validation for content: allow string or an array of typed parts
    const normalizedMessages = requestBody.messages.map((m: any) => {
      if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
        throw new Error('Each message must include a role.');
      }
      const content = m.content;
      const isStringContent = typeof content === 'string';
      const isArrayContent = Array.isArray(content);
      if (!isStringContent && !isArrayContent) {
        throw new Error('Message content must be a string or an array of content parts.');
      }
      if (isArrayContent) {
        content.forEach((part: any) => {
          if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
            throw new Error('Invalid content part: missing type.');
          }
          if (part.type === 'text' && typeof part.text !== 'string') {
            throw new Error('Text parts require a text field.');
          }
          if (part.type === 'image_url') {
            if (!part.image_url || typeof part.image_url.url !== 'string') {
              throw new Error('image_url parts require image_url.url.');
            }
          }
          if (part.type === 'input_audio') {
            if (!part.input_audio || typeof part.input_audio.data !== 'string' || typeof part.input_audio.format !== 'string') {
              throw new Error('input_audio parts require base64 data and format.');
            }
          }
        });
      }
      return { role: m.role, content };
    });
    
    let maxTokens: number | undefined = undefined;
    if (requestBody.max_tokens !== undefined && requestBody.max_tokens !== null) {
      const parsedTokens = parseInt(requestBody.max_tokens, 10);
      if (isNaN(parsedTokens) || parsedTokens <= 0) throw new Error('Invalid max_tokens.');
      maxTokens = parsedTokens;
    }
    return { messages: normalizedMessages, model: requestBody.model, max_tokens: maxTokens };
  } catch(error) {
    console.error("Error parsing request:", error);
    throw new Error(`Request parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Becomes async due to dataManager load/save
export async function updateUserTokenUsage(
  numberOfTokens: number,
  apiKey: string,
  options: {
    incrementRequest?: boolean;
    modelId?: string;
    promptTokens?: number;
    completionTokens?: number;
  } = {}
): Promise<void> {
  if (typeof numberOfTokens !== 'number' || isNaN(numberOfTokens) || numberOfTokens < 0) {
      logger.warn(`Invalid token count (${numberOfTokens}) for key ${hashToken(apiKey).slice(0, 12)}.`); return;
  }
  const incrementRequest = options.incrementRequest !== false;

  // Ensure pricing cache is warm
  await refreshPricingCache();

  const requestCost = calculateRequestCost(
    numberOfTokens,
    options.modelId,
    options.promptTokens,
    options.completionTokens
  );

  let keyFound = false;

  await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
    const userData = currentKeys[apiKey];
    if (!userData) {
      return currentKeys;
    }

    keyFound = true;
    userData.tokenUsage = (userData.tokenUsage || 0) + numberOfTokens;
    userData.requestCount = (userData.requestCount || 0) + (incrementRequest ? 1 : 0);
    if (requestCost > 0) {
      // Use 6 decimal places to avoid rounding away sub-cent per-request costs
      userData.estimatedCost = Math.round(((userData.estimatedCost || 0) + requestCost) * 1_000_000) / 1_000_000;
    }
    currentKeys[apiKey] = userData;
    return currentKeys;
  });

  if (!keyFound) {
    logger.warn(`Update token usage failed: key ${hashToken(apiKey).slice(0, 12)} not found.`);
  }
}
