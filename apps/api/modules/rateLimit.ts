import { SharedRateCounts } from './rateLimitRedis.js';

export interface TierRateLimits {
  rps: number;
  rpm: number;
  rpd: number;
}

export interface RequestTimestampStore {
  [apiKey: string]: number[];
}

export type RateLimitWindow = 'rps' | 'rpm' | 'rpd';

export interface RateLimitDecision {
  allowed: boolean;
  window?: RateLimitWindow;
  limit?: number;
  retryAfterSeconds?: number;
}

export function evaluateSharedRateLimit(sharedCounts: SharedRateCounts, limits: TierRateLimits): RateLimitDecision {
  if (limits.rps > 0 && sharedCounts.rps > limits.rps) {
    return { allowed: false, window: 'rps', limit: limits.rps, retryAfterSeconds: 1 };
  }
  if (limits.rpm > 0 && sharedCounts.rpm > limits.rpm) {
    return { allowed: false, window: 'rpm', limit: limits.rpm, retryAfterSeconds: 60 };
  }
  if (limits.rpd > 0 && sharedCounts.rpd > limits.rpd) {
    return { allowed: false, window: 'rpd', limit: limits.rpd, retryAfterSeconds: 86400 };
  }
  return { allowed: true };
}

export function enforceInMemoryRateLimit(
  store: RequestTimestampStore,
  apiKey: string,
  limits: TierRateLimits,
  now: number = Date.now()
): RateLimitDecision {
  store[apiKey] = store[apiKey] || [];
  const oneDayAgo = now - 86400000;
  const oneMinuteAgo = now - 60000;
  const oneSecondAgo = now - 1000;

  const recent = store[apiKey].filter((timestamp) => timestamp > oneDayAgo);
  store[apiKey] = recent;

  const secondTimestamps = recent.filter((timestamp) => timestamp > oneSecondAgo);
  if (limits.rps > 0 && secondTimestamps.length >= limits.rps) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (secondTimestamps[0] + 1000 - now) / 1000)));
    return { allowed: false, window: 'rps', limit: limits.rps, retryAfterSeconds };
  }

  const minuteTimestamps = recent.filter((timestamp) => timestamp > oneMinuteAgo);
  if (limits.rpm > 0 && minuteTimestamps.length >= limits.rpm) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (minuteTimestamps[0] + 60000 - now) / 1000)));
    return { allowed: false, window: 'rpm', limit: limits.rpm, retryAfterSeconds };
  }

  if (limits.rpd > 0 && recent.length >= limits.rpd) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (recent[0] + 86400000 - now) / 1000)));
    return { allowed: false, window: 'rpd', limit: limits.rpd, retryAfterSeconds };
  }

  store[apiKey].push(now);
  return { allowed: true };
}