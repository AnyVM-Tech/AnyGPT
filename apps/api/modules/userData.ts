import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request } from 'hyper-express';
// Import tiers.json directly for compile-time checking and type safety
import tiersData from '../tiers.json'; 

// --- Type Definitions --- 

// FIX: Ensure max_tokens allows null
interface TierData {
  rps: number;
  rpm: number;
  rpd: number;
  max_tokens: number | null; // Allowed null for unlimited
}

// Type for the entire tiers object (imported)
type TiersFile = Record<string, TierData>;

// This assignment should now work with the corrected TierData interface
const tiers: TiersFile = tiersData;

// UserData remains the same (no usage_start_date)
interface UserData {
  userId: string;
  tokenUsage: number; // Represents cumulative token usage
  role: 'admin' | 'user';
  tier: keyof TiersFile; 
}

interface KeysFile {
  [apiKey: string]: UserData;
}

// Resolve path relative to CWD. 
// REMOVED __dirname logic.
// IMPORTANT: This requires the process to be run from the project root.
const keysFilePath = path.resolve('keys.json');
console.log(`Using keys file path (relative to CWD): ${keysFilePath}`); 

// --- Function Definitions --- 

function loadKeys(): KeysFile {
  try {
    if (!fs.existsSync(keysFilePath)) {
        console.warn(`Keys file not found at ${keysFilePath}. Creating a new one.`);
        saveKeys({}); 
        return {};
    }
    const data = fs.readFileSync(keysFilePath, 'utf8');
    const parsedData = JSON.parse(data) as KeysFile;
    if (typeof parsedData !== 'object' || parsedData === null) {
        console.error(`Invalid keys.json format at ${keysFilePath}. Expected object. Resetting.`);
        saveKeys({}); 
        return {}; 
    }
    return parsedData;
  } catch (error) {
    console.error(`Error loading/parsing keys.json from ${keysFilePath}:`, error);
    return {}; 
  }
}

function saveKeys(keysToSave: KeysFile): void {
  try {
     if (typeof keysToSave !== 'object' || keysToSave === null) {
        console.error('Attempted to save invalid data to keys.json. Aborting.');
        return;
     }
    fs.writeFileSync(keysFilePath, JSON.stringify(keysToSave, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error saving keys.json to ${keysFilePath}:`, error);
  }
}

export function generateUserApiKey(userId: string): string {
  if (!userId) throw new Error('User ID required.');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const currentKeys = loadKeys(); 
  if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has API key.`);
  }
  if (!tiers.free) throw new Error("Config error: 'free' tier missing.");
  currentKeys[apiKey] = { userId, tokenUsage: 0, role: 'user', tier: 'free' };
  saveKeys(currentKeys); 
  console.log(`Generated key for ${userId}.`); 
  return apiKey;
}

export function generateAdminApiKey(userId: string): string {
   if (!userId) throw new Error('User ID required.');
   const apiKey = crypto.randomBytes(32).toString('hex');
   const currentKeys = loadKeys(); 
   if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has API key.`);
  }
   const adminTier: keyof TiersFile = tiers.enterprise ? 'enterprise' : (tiers.free ? 'free' : ''); 
   if (!adminTier) throw new Error("Config error: No admin tier found.");
  currentKeys[apiKey] = { userId, tokenUsage: 0, role: 'admin', tier: adminTier };
  saveKeys(currentKeys); 
  console.log(`Generated admin key for ${userId}.`);
  return apiKey;
}

// Validates key existence, tier validity, and checks cumulative token usage
export function validateApiKeyAndUsage(apiKey: string): { valid: boolean; userData?: UserData; tierLimits?: TierData, error?: string } {
  const currentKeys = loadKeys(); 
  const userData = currentKeys[apiKey];
  
  if (!userData) {
    return { valid: false, error: 'API key not found.' }; 
  }

  const tierLimits = tiers[userData.tier];
  if (!tierLimits) {
      const errorMsg = `Invalid tier ('${userData.tier}') configured for API key ${apiKey.substring(0,6)}...`;
      console.warn(errorMsg);
      return { valid: false, error: errorMsg }; 
  }

  // Check cumulative token usage against the tier's max_tokens limit
  if (tierLimits.max_tokens !== null && userData.tokenUsage >= tierLimits.max_tokens) {
      const errorMsg = `Cumulative token limit (${tierLimits.max_tokens}) reached for API key ${apiKey.substring(0,6)}... Usage: ${userData.tokenUsage}`;
      console.warn(errorMsg);
      return { valid: false, error: errorMsg, userData, tierLimits }; 
  }

  return { valid: true, userData, tierLimits }; 
}

// Can likely be removed, but kept for potential separate use.
export function getUserTierLimits(apiKey: string): TierData | null {
   const keys = loadKeys();
   const userData = keys[apiKey];
   if (!userData || !tiers[userData.tier]) {
       return null;
   }
   const limits: TierData = tiers[userData.tier];
   return limits;
}

export async function extractMessageFromRequest(request: Request): Promise<{ messages: { role: string; content: string }[]; model: string; max_tokens?: number }> {
   try {
    const requestBody = await request.json();
    if (!requestBody || typeof requestBody !== 'object') throw new Error('Invalid request: body missing/not object.');
    if (!Array.isArray(requestBody.messages)) throw new Error('Invalid format: messages must be array.');
    if (typeof requestBody.model !== 'string' || !requestBody.model) console.warn("Model not specified, using 'defaultModel'");

    let maxTokens: number | undefined = undefined;
    if (requestBody.max_tokens !== undefined && requestBody.max_tokens !== null) {
        const parsedTokens = parseInt(requestBody.max_tokens, 10);
        if (isNaN(parsedTokens) || parsedTokens <= 0) throw new Error('Invalid format: max_tokens must be positive integer.');
        maxTokens = parsedTokens;
    }
    return { messages: requestBody.messages, model: requestBody.model || 'defaultModel', max_tokens: maxTokens };
  } catch(error) {
      console.error("Error parsing request body:", error);
      throw new Error(`Failed to parse request body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function updateUserTokenUsage(numberOfTokens: number, apiKey: string): void {
  if (typeof numberOfTokens !== 'number' || isNaN(numberOfTokens) || numberOfTokens < 0) {
      console.warn(`Invalid token count (${numberOfTokens}) for API key ${apiKey}. Skipping update.`);
      return;
  }
  const currentKeys = loadKeys(); 
  const userData = currentKeys[apiKey];
  if (userData) {
    const currentUsage = typeof userData.tokenUsage === 'number' ? userData.tokenUsage : 0;
    userData.tokenUsage = currentUsage + numberOfTokens; 
    currentKeys[apiKey] = userData; 
    saveKeys(currentKeys); 
  } else {
    console.warn(`Attempted token usage update for non-existent API key: ${apiKey}.`);
  }
}
