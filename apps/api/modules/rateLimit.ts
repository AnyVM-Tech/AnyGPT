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

export interface InMemoryRateCounts {
  counts: SharedRateCounts;
  oldestTimestamps: Partial<Record<RateLimitWindow, number>>;
}

function getWindowDurationMs(window: RateLimitWindow): number {
  if (window === 'rps') return 1000;
  if (window === 'rpm') return 60_000;
  return 86_400_000;
}

export function getRateLimitRetryAfterSeconds(
  window: RateLimitWindow,
  now: number = Date.now(),
  oldestTimestamp?: number,
): number {
  if (typeof oldestTimestamp === 'number' && Number.isFinite(oldestTimestamp)) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(Math.max(0, (oldestTimestamp + getWindowDurationMs(window) - now) / 1000)),
    );
    return retryAfterSeconds;
  }

  if (window === 'rps') {
    const nextSecondMs = (Math.floor(now / 1000) + 1) * 1000;
    return Math.max(1, Math.ceil((nextSecondMs - now) / 1000));
  }
  if (window === 'rpm') {
    const nextMinuteMs = (Math.floor(now / 60_000) + 1) * 60_000;
    return Math.max(1, Math.ceil((nextMinuteMs - now) / 1000));
  }
  const nextDayMs = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  return Math.max(1, Math.ceil((nextDayMs - now) / 1000));
}

export function evaluateRateLimitCounts(
  counts: SharedRateCounts,
  limits: TierRateLimits,
  now: number = Date.now(),
  oldestTimestamps: Partial<Record<RateLimitWindow, number>> = {},
): RateLimitDecision {
  if (limits.rps > 0 && counts.rps >= limits.rps) {
    return {
      allowed: false,
      window: 'rps',
      limit: limits.rps,
      retryAfterSeconds: getRateLimitRetryAfterSeconds('rps', now, oldestTimestamps.rps),
    };
  }
  if (limits.rpm > 0 && counts.rpm >= limits.rpm) {
    return {
      allowed: false,
      window: 'rpm',
      limit: limits.rpm,
      retryAfterSeconds: getRateLimitRetryAfterSeconds('rpm', now, oldestTimestamps.rpm),
    };
  }
  if (limits.rpd > 0 && counts.rpd >= limits.rpd) {
    return {
      allowed: false,
      window: 'rpd',
      limit: limits.rpd,
      retryAfterSeconds: getRateLimitRetryAfterSeconds('rpd', now, oldestTimestamps.rpd),
    };
  }
  return { allowed: true };
}

export function evaluateSharedRateLimit(sharedCounts: SharedRateCounts, limits: TierRateLimits): RateLimitDecision {
  return evaluateRateLimitCounts(sharedCounts, limits);
}

export function readInMemoryRateCounts(
  store: RequestTimestampStore,
  apiKey: string,
  now: number = Date.now(),
): InMemoryRateCounts {
  const timestamps = store[apiKey] || [];
  const oneDayAgo = now - getWindowDurationMs('rpd');
  const oneMinuteAgo = now - getWindowDurationMs('rpm');
  const oneSecondAgo = now - getWindowDurationMs('rps');

  const recent = timestamps.filter((timestamp) => timestamp > oneDayAgo);
  if (recent.length === 0) {
    delete store[apiKey];
  } else {
    store[apiKey] = recent;
  }

  const secondTimestamps = recent.filter((timestamp) => timestamp > oneSecondAgo);
  const minuteTimestamps = recent.filter((timestamp) => timestamp > oneMinuteAgo);

  return {
    counts: {
      rps: secondTimestamps.length,
      rpm: minuteTimestamps.length,
      rpd: recent.length,
    },
    oldestTimestamps: {
      ...(secondTimestamps.length > 0 ? { rps: secondTimestamps[0] } : {}),
      ...(minuteTimestamps.length > 0 ? { rpm: minuteTimestamps[0] } : {}),
      ...(recent.length > 0 ? { rpd: recent[0] } : {}),
    },
  };
}

export function incrementInMemoryRateCounts(
  store: RequestTimestampStore,
  apiKey: string,
  now: number = Date.now(),
): InMemoryRateCounts {
  const { counts } = readInMemoryRateCounts(store, apiKey, now);
  if (!store[apiKey]) {
    store[apiKey] = [];
  }
  store[apiKey].push(now);
  return {
    counts: {
      rps: counts.rps + 1,
      rpm: counts.rpm + 1,
      rpd: counts.rpd + 1,
    },
    oldestTimestamps: readInMemoryRateCounts(store, apiKey, now).oldestTimestamps,
  };
}

export function enforceInMemoryRateLimit(
  store: RequestTimestampStore,
  apiKey: string,
  limits: TierRateLimits,
  now: number = Date.now()
): RateLimitDecision {
  const { counts, oldestTimestamps } = readInMemoryRateCounts(store, apiKey, now);
  const decision = evaluateRateLimitCounts(counts, limits, now, oldestTimestamps);
  if (!decision.allowed) {
    return decision;
  }
  incrementInMemoryRateCounts(store, apiKey, now);
  return { allowed: true };
}
