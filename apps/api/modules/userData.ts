import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request } from 'hyper-express';

const keysFilePath = '../api/keys.json';

interface UserData {
  userId: string;
  tokenUsage: number;
  role: 'admin' | 'user';
}

interface KeysFile {
  [apiKey: string]: UserData;
}

function loadKeys(): KeysFile {
  try {
    if (fs.existsSync(keysFilePath)) {
      const data = fs.readFileSync(keysFilePath, 'utf8');
      return JSON.parse(data) as KeysFile;
    } else {
      return {};
    }
  } catch (error) {
    console.error('Error loading keys:', error);
    return {};
  }
}

function saveKeys(keys: KeysFile): void {
  try {
    fs.writeFileSync(keysFilePath, JSON.stringify(keys, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving keys:', error);
  }
}

export function generateUserApiKey(userId: string): string {
  if (!userId) {
    throw new Error('User ID is required to generate a user API key.');
  }

  const apiKey = crypto.randomBytes(32).toString('hex');

  const keys = loadKeys();

  const existingApiKey = Object.keys(keys).find(key => keys[key].userId === userId);
  if (existingApiKey) {
    throw new Error(`User ID ${userId} already exists.`);
  }

  keys[apiKey] = {
    userId: userId,
    tokenUsage: 0, 
    role: 'user',
  };
  saveKeys(keys);

  return apiKey;
}

export function generateAdminApiKey(userId: string): string {
  if (!userId) {
    throw new Error('User ID is required to generate an admin API key.');
  }

  const apiKey = crypto.randomBytes(32).toString('hex');

  const keys = loadKeys();

  const existingApiKey = Object.keys(keys).find(key => keys[key].userId === userId);
  if (existingApiKey) {
    throw new Error(`User ID ${userId} already exists.`);
  }

  keys[apiKey] = {
    userId: userId,
    tokenUsage: 0,
    role: 'admin',
  };
  saveKeys(keys);

  return apiKey;
}

export function validateApiKey(apiKey: string): UserData | null {
  const keys = loadKeys();

  const userData = keys[apiKey];
  if (userData) {
    return userData;
  } else {
    return null;
  }
}


export async function extractMessageFromRequest(request: Request): Promise<{ messages: { role: string; content: string }[]; model: string }> {
  const requestBody = await request.json();
  return { messages: requestBody.messages, model: requestBody.model || 'defaultModel' };
}
export function updateUserTokenUsage(numberOfTokens: number, apiKey: string): void {
  const keys = loadKeys();

  const userData = keys[apiKey];
  if (userData) {
    userData.tokenUsage += numberOfTokens;

    keys[apiKey] = userData;
    saveKeys(keys);
  } else {
    console.warn(`API key ${apiKey} not found.`);
  }
}