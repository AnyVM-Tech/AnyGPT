import crypto from 'crypto';
// Remove direct fs import if no longer needed
// import fs from 'fs'; 
import path from 'path';
import { Request } from 'hyper-express';
// Import the singleton DataManager instance
import { dataManager } from './dataManager'; 
// Import tiers data directly (static configuration)
import tiersData from '../tiers.json'; 

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
  role: 'admin' | 'user';
  tier: keyof TiersFile; // Use keyof TiersFile for better type safety
}
// Define KeysFile structure locally or import if shared
interface KeysFile { [apiKey: string]: UserData; }

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

  currentKeys[apiKey] = { userId, tokenUsage: 0, role: role, tier: finalTier };
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

  currentKeys[apiKey] = { userId, tokenUsage: 0, role: 'admin', tier: adminTier };
  await dataManager.save<KeysFile>('keys', currentKeys); 
  console.log(`Generated admin key for ${userId}.`);
  return apiKey;
}

// Becomes async due to dataManager.load
export async function validateApiKeyAndUsage(apiKey: string): Promise<{ valid: boolean; userData?: UserData; tierLimits?: TierData, error?: string }> {
  const currentKeys = await dataManager.load<KeysFile>('keys'); 
  const userData = currentKeys[apiKey];
  
  if (!userData) return { valid: false, error: 'API key not found.' }; 

  const tierLimits = tiers[userData.tier]; // tiers is static import
  if (!tierLimits) {
      const errorMsg = `Invalid tier ('${userData.tier}') for key ${apiKey.substring(0,6)}...`;
      return { valid: false, error: errorMsg, userData }; 
  }
  if (tierLimits.max_tokens !== null && userData.tokenUsage >= tierLimits.max_tokens) {
      const errorMsg = `Token limit (${tierLimits.max_tokens}) reached for key ${apiKey.substring(0,6)}...`;
      return { valid: false, error: errorMsg, userData, tierLimits }; 
  }
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

// extractMessageFromRequest remains synchronous (no data access)
export async function extractMessageFromRequest(request: Request): Promise<{ messages: { role: string; content: string }[]; model: string; max_tokens?: number }> { 
    // ... implementation remains same ...
    try {
        const requestBody = await request.json();
        if (!requestBody || typeof requestBody !== 'object') throw new Error('Invalid body.');
        if (!Array.isArray(requestBody.messages)) throw new Error('Invalid messages format.');
        if (typeof requestBody.model !== 'string' || !requestBody.model) console.warn("Default model used.");
    
        let maxTokens: number | undefined = undefined;
        if (requestBody.max_tokens !== undefined && requestBody.max_tokens !== null) {
            const parsedTokens = parseInt(requestBody.max_tokens, 10);
            if (isNaN(parsedTokens) || parsedTokens <= 0) throw new Error('Invalid max_tokens.');
            maxTokens = parsedTokens;
        }
        return { messages: requestBody.messages, model: requestBody.model || 'defaultModel', max_tokens: maxTokens };
    } catch(error) {
        console.error("Error parsing request:", error);
        throw new Error(`Request parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Becomes async due to dataManager load/save
export async function updateUserTokenUsage(numberOfTokens: number, apiKey: string): Promise<void> {
  if (typeof numberOfTokens !== 'number' || isNaN(numberOfTokens) || numberOfTokens < 0) {
      console.warn(`Invalid token count (${numberOfTokens}) for ${apiKey}.`); return;
  }
  const currentKeys = await dataManager.load<KeysFile>('keys'); 
  const userData = currentKeys[apiKey];
  if (userData) {
    userData.tokenUsage = (userData.tokenUsage || 0) + numberOfTokens; 
    currentKeys[apiKey] = userData; 
    await dataManager.save<KeysFile>('keys', currentKeys); 
  } else {
    console.warn(`Update token usage failed: key ${apiKey} not found.`);
  }
}
