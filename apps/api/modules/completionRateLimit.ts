import redis, { redisReadyPromise } from './db.js';
import { logger } from './logger.js';
import { hashToken } from './redaction.js';
import {
  evaluateRateLimitCounts,
  incrementInMemoryRateCounts,
  readInMemoryRateCounts,
  type RateLimitDecision,
  type RequestTimestampStore,
  type TierRateLimits,
} from './rateLimit.js';
import {
  incrementSharedRateLimitCounters,
  readSharedRateLimitCounters,
  type SharedRateCounts,
} from './rateLimitRedis.js';

const COMPLETION_RATE_LIMIT_KEY_PREFIX = 'api:completion-ratelimit:';
const localCompletionRateStore: RequestTimestampStore = {};

export async function readCompletionRateLimitCounters(apiKey: string): Promise<SharedRateCounts> {
  if (redis && redis.status !== 'ready' && redisReadyPromise) {
    try {
      await redisReadyPromise;
    } catch {
      // Fall back to local completion counters if Redis is unavailable.
    }
  }
  const sharedCounts = await readSharedRateLimitCounters(
    redis,
    COMPLETION_RATE_LIMIT_KEY_PREFIX,
    apiKey,
  );
  if (sharedCounts) {
    return sharedCounts;
  }
  return readInMemoryRateCounts(localCompletionRateStore, apiKey).counts;
}

export async function incrementCompletionRateLimitCounters(apiKey: string): Promise<SharedRateCounts> {
  if (redis && redis.status !== 'ready' && redisReadyPromise) {
    try {
      await redisReadyPromise;
    } catch {
      // Fall back to local completion counters if Redis is unavailable.
    }
  }
  const sharedCounts = await incrementSharedRateLimitCounters(
    redis,
    COMPLETION_RATE_LIMIT_KEY_PREFIX,
    apiKey,
    { rps: true, rpm: true, rpd: true },
  );
  if (sharedCounts) {
    return sharedCounts;
  }
  return incrementInMemoryRateCounts(localCompletionRateStore, apiKey).counts;
}

export function evaluateCompletionRateLimit(
  counts: SharedRateCounts,
  limits: TierRateLimits,
  nowMs: number = Date.now(),
): RateLimitDecision {
  return evaluateRateLimitCounts(counts, limits, nowMs);
}

export function logCompletionRateLimitIncrementFailure(apiKey: string, error: unknown): void {
  const keyId = hashToken(apiKey).slice(0, 12);
  logger.warn(
    `[RateLimit] Failed to persist successful completion counters for key ${keyId}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
