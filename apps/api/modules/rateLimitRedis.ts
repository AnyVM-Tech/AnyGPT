import crypto from 'crypto';
import type { Redis } from './db.js';
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
local incSecond = ARGV[5] == '1'
local incMinute = ARGV[6] == '1'
local incDay = ARGV[7] == '1'

local s_ts = redis.call('HGET', key, 's_ts')
local m_ts = redis.call('HGET', key, 'm_ts')
local d_ts = redis.call('HGET', key, 'd_ts')

local s_count = 0
local m_count = 0
local d_count = 0

if s_ts == secBucket then
  s_count = tonumber(redis.call('HGET', key, 's_count') or '0')
else
  s_count = 0
end

if m_ts == minBucket then
  m_count = tonumber(redis.call('HGET', key, 'm_count') or '0')
else
  m_count = 0
end

if d_ts == dayBucket then
  d_count = tonumber(redis.call('HGET', key, 'd_count') or '0')
else
  d_count = 0
end

if incSecond then
  if s_ts == secBucket then
    s_count = redis.call('HINCRBY', key, 's_count', 1)
  else
    redis.call('HSET', key, 's_ts', secBucket, 's_count', 1)
    s_count = 1
  end
end

if incMinute then
  if m_ts == minBucket then
    m_count = redis.call('HINCRBY', key, 'm_count', 1)
  else
    redis.call('HSET', key, 'm_ts', minBucket, 'm_count', 1)
    m_count = 1
  end
end

if incDay then
  if d_ts == dayBucket then
    d_count = redis.call('HINCRBY', key, 'd_count', 1)
  else
    redis.call('HSET', key, 'd_ts', dayBucket, 'd_count', 1)
    d_count = 1
  end
end

if incSecond or incMinute or incDay then
  redis.call('EXPIRE', key, ttl)
end
return {s_count, m_count, d_count}
`;

const RATE_LIMIT_HASH_SECRET: string = process.env.RATE_LIMIT_HASH_SECRET
  || process.env.API_KEY_HASH_SECRET
  || crypto.randomBytes(32).toString('hex');
const RATE_LIMIT_HASH_ITERATIONS = (() => {
  const raw = Number(process.env.RATE_LIMIT_HASH_ITERATIONS);
  if (Number.isFinite(raw) && raw >= 1000) return Math.floor(raw);
  return 20_000;
})();
const RATE_LIMIT_HASH_KEYLEN = (() => {
  const raw = Number(process.env.RATE_LIMIT_HASH_KEYLEN);
  if (Number.isFinite(raw) && raw >= 16) return Math.floor(raw);
  return 32;
})();
const RATE_LIMIT_HASH_DIGEST = 'sha256';
const RATE_LIMIT_HASH_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.RATE_LIMIT_HASH_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 5 * 60 * 1000;
})();
const RATE_LIMIT_HASH_CACHE_MAX = (() => {
  const raw = Number(process.env.RATE_LIMIT_HASH_CACHE_MAX);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 10_000;
})();
type HashCacheEntry = { value: string; expiresAt: number };
const apiKeyHashCache = new Map<string, HashCacheEntry>();
let warnedDefaultSecret = false;

function getCachedApiKeyHash(apiKey: string): string | null {
  if (RATE_LIMIT_HASH_CACHE_MAX <= 0 || RATE_LIMIT_HASH_CACHE_TTL_MS <= 0) return null;
  const entry = apiKeyHashCache.get(apiKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    apiKeyHashCache.delete(apiKey);
    return null;
  }
  apiKeyHashCache.delete(apiKey);
  apiKeyHashCache.set(apiKey, entry);
  return entry.value;
}

function setCachedApiKeyHash(apiKey: string, value: string): void {
  if (RATE_LIMIT_HASH_CACHE_MAX <= 0 || RATE_LIMIT_HASH_CACHE_TTL_MS <= 0) return;
  if (apiKeyHashCache.size >= RATE_LIMIT_HASH_CACHE_MAX) {
    const oldestKey = apiKeyHashCache.keys().next().value;
    if (oldestKey) apiKeyHashCache.delete(oldestKey);
  }
  apiKeyHashCache.set(apiKey, { value, expiresAt: Date.now() + RATE_LIMIT_HASH_CACHE_TTL_MS });
}

// Derive a stable, computationally hardened hash for API keys used in rate limiting.
// Use PBKDF2 (a standard, iterated key-derivation function) to increase the
// computational cost of deriving the hash while keeping it deterministic per API key.
function deriveApiKeyHash(context: string, apiKey: string): string {
  // Derive a context-bound salt from the shared secret to keep the result stable
  // while preventing simple precomputation attacks.
  const salt = crypto.createHmac('sha256', RATE_LIMIT_HASH_SECRET)
    .update(context)
    .digest();

  const derived = crypto.pbkdf2Sync(
    apiKey,
    salt,
    RATE_LIMIT_HASH_ITERATIONS,
    RATE_LIMIT_HASH_KEYLEN,
    RATE_LIMIT_HASH_DIGEST,
  );

  return derived.toString('hex');
}

function hashApiKey(apiKey: string): string {
  if (!process.env.RATE_LIMIT_HASH_SECRET && !process.env.API_KEY_HASH_SECRET && !warnedDefaultSecret) {
    warnedDefaultSecret = true;
    logger.warn('[RateLimit] RATE_LIMIT_HASH_SECRET is not set; using a randomly generated per-process hash secret.');
  }
  const cached = getCachedApiKeyHash(apiKey);
  if (cached) return cached;
  const context = 'rate-limit:api-key:';
  const derived = deriveApiKeyHash(context, apiKey);
  setCachedApiKeyHash(apiKey, derived);
  return derived;
}

export interface SharedRateLimitIncrementOptions {
  rps?: boolean;
  rpm?: boolean;
  rpd?: boolean;
}

async function readOrIncrementSharedRateLimitCounters(
  redisClient: Redis | null,
  keyPrefix: string,
  apiKey: string,
  options: SharedRateLimitIncrementOptions,
): Promise<SharedRateCounts | null> {
  if (!redisClient || redisClient.status !== 'ready') return null;

  const nowMs = Date.now();
  const secondBucket = Math.floor(nowMs / 1000).toString();
  const minuteBucket = Math.floor(nowMs / 60_000).toString();
  const dayBucket = Math.floor(nowMs / 86_400_000).toString();
  const key = `${keyPrefix}${hashApiKey(apiKey)}`;
  const incrementRps = options.rps === true ? '1' : '0';
  const incrementRpm = options.rpm === true ? '1' : '0';
  const incrementRpd = options.rpd === true ? '1' : '0';

  try {
    const result = await redisClient.eval(
      RATE_LIMIT_HASH_SCRIPT,
      1,
      key,
      secondBucket,
      minuteBucket,
      dayBucket,
      '90000',
      incrementRps,
      incrementRpm,
      incrementRpd,
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

export async function incrementSharedRateLimitCounters(
  redisClient: Redis | null,
  keyPrefix: string,
  apiKey: string,
  options: SharedRateLimitIncrementOptions = { rps: true, rpm: true, rpd: true },
): Promise<SharedRateCounts | null> {
  return readOrIncrementSharedRateLimitCounters(redisClient, keyPrefix, apiKey, options);
}

export async function readSharedRateLimitCounters(
  redisClient: Redis | null,
  keyPrefix: string,
  apiKey: string,
): Promise<SharedRateCounts | null> {
  return readOrIncrementSharedRateLimitCounters(redisClient, keyPrefix, apiKey, {
    rps: false,
    rpm: false,
    rpd: false,
  });
}
