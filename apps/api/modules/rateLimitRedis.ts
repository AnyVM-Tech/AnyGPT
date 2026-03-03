import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';

export interface SharedRateCounts {
  rps: number;
  rpm: number;
  rpd: number;
}

const RATE_LIMIT_HASH_SCRIPT = `
local key = KEYS[1]
local secBucket = ARGV[1]
local minBucket = ARGV[2]
local dayBucket = ARGV[3]
local ttl = tonumber(ARGV[4])

local s_ts = redis.call('HGET', key, 's_ts')
local m_ts = redis.call('HGET', key, 'm_ts')
local d_ts = redis.call('HGET', key, 'd_ts')

local s_count = 0
local m_count = 0
local d_count = 0

if s_ts == secBucket then
  s_count = redis.call('HINCRBY', key, 's_count', 1)
else
  redis.call('HSET', key, 's_ts', secBucket, 's_count', 1)
  s_count = 1
end

if m_ts == minBucket then
  m_count = redis.call('HINCRBY', key, 'm_count', 1)
else
  redis.call('HSET', key, 'm_ts', minBucket, 'm_count', 1)
  m_count = 1
end

if d_ts == dayBucket then
  d_count = redis.call('HINCRBY', key, 'd_count', 1)
else
  redis.call('HSET', key, 'd_ts', dayBucket, 'd_count', 1)
  d_count = 1
end

redis.call('EXPIRE', key, ttl)
return {s_count, m_count, d_count}
`;

const RATE_LIMIT_HASH_SECRET: string = process.env.RATE_LIMIT_HASH_SECRET
  || process.env.API_KEY_HASH_SECRET
  || crypto.randomBytes(32).toString('hex');
let warnedDefaultSecret = false;

// Derive a stable, computationally hardened hash for API keys used in rate limiting.
// This uses iterated HMAC-SHA256 with a fixed number of rounds to increase
// the cost over a single hash while remaining lightweight enough for per-request use.
function deriveApiKeyHash(context: string, apiKey: string): string {
  // Initial HMAC over context and apiKey
  let digest = crypto.createHmac('sha256', RATE_LIMIT_HASH_SECRET)
    .update(context + apiKey)
    .digest();

  // Apply additional HMAC iterations to increase computational effort
  const iterations = 1000;
  for (let i = 0; i < iterations; i++) {
    const hmac = crypto.createHmac('sha256', RATE_LIMIT_HASH_SECRET);
    hmac.update(digest);
    hmac.update('rate-limit:iter'); // domain separation label
    digest = hmac.digest();
  }

  return digest.toString('hex');
}

function hashApiKey(apiKey: string): string {
  if (!process.env.RATE_LIMIT_HASH_SECRET && !process.env.API_KEY_HASH_SECRET && !warnedDefaultSecret) {
    warnedDefaultSecret = true;
    logger.warn('[RateLimit] RATE_LIMIT_HASH_SECRET is not set; using a randomly generated per-process hash secret.');
  }
  const context = 'rate-limit:api-key:';
  return deriveApiKeyHash(context, apiKey);
}

export async function incrementSharedRateLimitCounters(
  redisClient: Redis | null,
  keyPrefix: string,
  apiKey: string,
): Promise<SharedRateCounts | null> {
  if (!redisClient || redisClient.status !== 'ready') return null;

  const nowMs = Date.now();
  const secondBucket = Math.floor(nowMs / 1000).toString();
  const minuteBucket = Math.floor(nowMs / 60_000).toString();
  const dayBucket = Math.floor(nowMs / 86_400_000).toString();
  const key = `${keyPrefix}${hashApiKey(apiKey)}`;

  try {
    const result = await redisClient.eval(
      RATE_LIMIT_HASH_SCRIPT,
      1,
      key,
      secondBucket,
      minuteBucket,
      dayBucket,
      '90000',
    );

    if (!Array.isArray(result) || result.length < 3) return null;
    return {
      rps: Number(result[0]),
      rpm: Number(result[1]),
      rpd: Number(result[2]),
    };
  } catch {
    return null;
  }
}
