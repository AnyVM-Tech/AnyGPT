import type { Redis } from 'ioredis';

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
  const key = `${keyPrefix}${apiKey}`;

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