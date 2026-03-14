import { dataManager } from './dataManager.js';
import redis from './db.js';
import { hashToken, redactToken } from './redaction.js';
import type { KeysFile, TierData } from './userData.js';

const KEYS_REDIS_HASH_KEY = 'api:data';
const KEYS_REDIS_FIELD = 'k';
const KEYS_REDIS_LEGACY_KEY = 'api:keys_data';

export type KeyUsageSource = 'cache' | 'redis' | 'filesystem-fallback';

export function buildKeyDetailsPayload(apiKey: string, userData: KeysFile[string], tierLimits: TierData | any, source: KeyUsageSource) {
  const maxTokens = tierLimits?.max_tokens ?? null;
  const tokenUsage = typeof userData.tokenUsage === 'number' ? userData.tokenUsage : 0;
  const requestCount = typeof userData.requestCount === 'number' ? userData.requestCount : 0;
  const remainingTokens = maxTokens !== null ? Math.max(0, maxTokens - tokenUsage) : null;

  return {
    api_key_preview: redactToken(apiKey),
    api_key_hash: hashToken(apiKey),
    user: { id: userData.userId, role: userData.role },
    tier: { id: userData.tier, limits: tierLimits },
    usage: {
      token_usage: tokenUsage,
      request_count: requestCount,
      remaining_tokens: remainingTokens,
      max_tokens: maxTokens,
    },
    source,
    timestamp: new Date().toISOString(),
  };
}

export async function loadKeysLiveSnapshot(): Promise<{ keys: KeysFile; source: KeyUsageSource }> {
  const redisClient = redis;
  if (redisClient?.status === 'ready') {
    try {
      const redisRaw = await redisClient.hget(KEYS_REDIS_HASH_KEY, KEYS_REDIS_FIELD)
        || await redisClient.get(KEYS_REDIS_LEGACY_KEY);
      if (redisRaw) {
        return {
          keys: JSON.parse(redisRaw) as KeysFile,
          source: 'redis',
        };
      }
    } catch (error) {
      console.warn('[KeysLive] Failed reading live keys from Redis. Falling back to DataManager.', error);
    }
  }

  return {
    keys: await dataManager.load<KeysFile>('keys'),
    source: 'filesystem-fallback',
  };
}
