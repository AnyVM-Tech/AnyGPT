import { dataManager } from './dataManager.js';
import redis from './db.js';
import { hashToken, redactToken } from './redaction.js';
import { buildPublicPlanPayload } from './planAccess.js';
import type { KeysFile, TierData } from './userData.js';

const KEYS_REDIS_HASH_KEY = 'api:data';
const KEYS_REDIS_FIELD = 'k';
const KEYS_REDIS_LEGACY_KEY = 'api:keys_data';

export type KeyUsageSource = 'cache' | 'redis' | 'filesystem-fallback';

function normalizeCounter(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeUsd(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function normalizeOptionalCounter(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function getUtcDayBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function normalizeDayBucket(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return Number.isFinite(Date.parse(`${trimmed}T00:00:00.000Z`)) ? trimmed : null;
}

function computeProgress(current: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.round((current / total) * 1_000_000) / 1_000_000;
}

function computeAgeSeconds(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

export function deriveKeyUsageSnapshot(userData: KeysFile[string], tierLimits?: TierData | any) {
  const maxTokens = tierLimits?.max_tokens ?? null;
  const totalTokenUsage = normalizeCounter(userData.tokenUsage);
  const totalRequestCount = normalizeCounter(userData.requestCount);
  const paidTokenUsage = Math.min(totalTokenUsage, normalizeCounter(userData.paidTokenUsage));
  const paidRequestCount = Math.min(totalRequestCount, normalizeCounter(userData.paidRequestCount));
  const billingPeriodTokenUsage = Math.max(0, totalTokenUsage - paidTokenUsage);
  const billingPeriodRequestCount = Math.max(0, totalRequestCount - paidRequestCount);
  const totalEstimatedCost = normalizeUsd(userData.estimatedCost);
  const paidEstimatedCost = Math.min(totalEstimatedCost, normalizeUsd(userData.paidEstimatedCost));
  const billingPeriodEstimatedCost = Math.round(
    Math.max(0, totalEstimatedCost - paidEstimatedCost) * 1_000_000
  ) / 1_000_000;
  const remainingTokens = maxTokens !== null ? Math.max(0, maxTokens - billingPeriodTokenUsage) : null;
  const currentDayBucket = getUtcDayBucket();
  const storedDayBucket = normalizeDayBucket((userData as any).dailyRequestDate);
  const currentDayRequestCount = storedDayBucket === currentDayBucket
    ? normalizeCounter((userData as any).dailyRequestCount)
    : 0;
  const dailyRequestTarget = normalizeOptionalCounter(tierLimits?.soft_rpd);
  const dailyRequestHardCap = normalizeOptionalCounter(tierLimits?.rpd);
  const billingPeriodRequestTarget = normalizeOptionalCounter(tierLimits?.billing_period_request_target);
  const dailyRequestTargetRemaining = dailyRequestTarget !== null
    ? Math.max(0, dailyRequestTarget - currentDayRequestCount)
    : null;
  const dailyRequestHardCapRemaining = dailyRequestHardCap !== null
    ? Math.max(0, dailyRequestHardCap - currentDayRequestCount)
    : null;
  const billingPeriodRequestTargetRemaining = billingPeriodRequestTarget !== null
    ? Math.max(0, billingPeriodRequestTarget - billingPeriodRequestCount)
    : null;
  const dailyRequestWarningActive = dailyRequestTarget !== null && currentDayRequestCount > dailyRequestTarget;
  const dailyRequestWarningExceededBy = dailyRequestWarningActive && dailyRequestTarget !== null
    ? currentDayRequestCount - dailyRequestTarget
    : 0;
  const warnings = dailyRequestWarningActive && dailyRequestTarget !== null
    ? [
        {
          code: 'daily_request_target_exceeded',
          level: 'warning',
          date: currentDayBucket,
          metric: 'rpd',
          current: currentDayRequestCount,
          threshold: dailyRequestTarget,
          hardCap: dailyRequestHardCap,
          message: `Daily billed requests are over target for today (${currentDayRequestCount}/${dailyRequestTarget}${dailyRequestHardCap !== null ? `, hard cap ${dailyRequestHardCap}` : ''}).`,
        },
      ]
    : [];
  const warningTicker = warnings[0]?.message ?? null;
  const billingPeriodStartedAt = typeof userData.billingPeriodStartedAt === 'string' ? userData.billingPeriodStartedAt : null;
  const lastBillingSettlementAt = typeof userData.lastBillingSettlementAt === 'string' ? userData.lastBillingSettlementAt : null;
  const billingPeriodAgeSeconds = computeAgeSeconds(billingPeriodStartedAt);
  const billingPeriodAgeDays = billingPeriodAgeSeconds !== null
    ? Math.round((billingPeriodAgeSeconds / 86400) * 1_000_000) / 1_000_000
    : null;

  return {
    maxTokens,
    remainingTokens,
    totalTokenUsage,
    paidTokenUsage,
    billingPeriodTokenUsage,
    outstandingTokenUsage: billingPeriodTokenUsage,
    totalRequestCount,
    paidRequestCount,
    billingPeriodRequestCount,
    outstandingRequestCount: billingPeriodRequestCount,
    totalEstimatedCost,
    paidEstimatedCost,
    billingPeriodEstimatedCost,
    outstandingEstimatedCost: billingPeriodEstimatedCost,
    currentDayRequestDate: currentDayBucket,
    currentDayRequestCount,
    dailyRequestTarget,
    dailyRequestTargetRemaining,
    dailyRequestHardCap,
    dailyRequestHardCapRemaining,
    dailyRequestWarningActive,
    dailyRequestWarningExceededBy,
    dailyRequestTargetProgress: computeProgress(currentDayRequestCount, dailyRequestTarget),
    dailyRequestHardCapProgress: computeProgress(currentDayRequestCount, dailyRequestHardCap),
    billingPeriodRequestTarget,
    billingPeriodRequestTargetRemaining,
    billingPeriodRequestTargetProgress: computeProgress(billingPeriodRequestCount, billingPeriodRequestTarget),
    maxTokensProgress: computeProgress(billingPeriodTokenUsage, maxTokens),
    warnings,
    warningTicker,
    billingPeriodStartedAt,
    lastBillingSettlementAt,
    billingPeriodAgeSeconds,
    billingPeriodAgeDays,
  };
}

export function buildKeyDetailsPayload(apiKey: string, userData: KeysFile[string], tierLimits: TierData | any, source: KeyUsageSource) {
  const snapshot = deriveKeyUsageSnapshot(userData, tierLimits);
  const plan = buildPublicPlanPayload(userData.tier, tierLimits);
  return {
    api_key_preview: redactToken(apiKey),
    api_key_hash: hashToken(apiKey),
    user: { id: userData.userId, role: userData.role },
    tier: { id: userData.tier, name: plan.name, limits: plan.limits },
    plan,
    usage: {
      token_usage: snapshot.totalTokenUsage,
      total_token_usage: snapshot.totalTokenUsage,
      paid_token_usage: snapshot.paidTokenUsage,
      billing_period_token_usage: snapshot.billingPeriodTokenUsage,
      outstanding_token_usage: snapshot.outstandingTokenUsage,
      request_count: snapshot.totalRequestCount,
      total_request_count: snapshot.totalRequestCount,
      paid_request_count: snapshot.paidRequestCount,
      billing_period_request_count: snapshot.billingPeriodRequestCount,
      outstanding_request_count: snapshot.outstandingRequestCount,
      current_day_request_date: snapshot.currentDayRequestDate,
      current_day_request_count: snapshot.currentDayRequestCount,
      daily_request_target: snapshot.dailyRequestTarget,
      daily_request_target_remaining: snapshot.dailyRequestTargetRemaining,
      daily_request_hard_cap: snapshot.dailyRequestHardCap,
      daily_request_hard_cap_remaining: snapshot.dailyRequestHardCapRemaining,
      daily_request_warning_active: snapshot.dailyRequestWarningActive,
      daily_request_warning_exceeded_by: snapshot.dailyRequestWarningExceededBy,
      daily_request_target_progress: snapshot.dailyRequestTargetProgress,
      daily_request_hard_cap_progress: snapshot.dailyRequestHardCapProgress,
      billing_period_request_target: snapshot.billingPeriodRequestTarget,
      billing_period_request_target_remaining: snapshot.billingPeriodRequestTargetRemaining,
      billing_period_request_target_progress: snapshot.billingPeriodRequestTargetProgress,
      estimated_cost: snapshot.totalEstimatedCost,
      total_estimated_cost: snapshot.totalEstimatedCost,
      paid_estimated_cost: snapshot.paidEstimatedCost,
      billing_period_estimated_cost: snapshot.billingPeriodEstimatedCost,
      outstanding_estimated_cost: snapshot.outstandingEstimatedCost,
      remaining_tokens: snapshot.remainingTokens,
      max_tokens: snapshot.maxTokens,
      max_tokens_progress: snapshot.maxTokensProgress,
    },
    billing: {
      model: 'payg',
      billing_period_started_at: snapshot.billingPeriodStartedAt,
      last_billing_settlement_at: snapshot.lastBillingSettlementAt,
      billing_period_age_seconds: snapshot.billingPeriodAgeSeconds,
      billing_period_age_days: snapshot.billingPeriodAgeDays,
    },
    warnings: snapshot.warnings,
    warning_ticker: snapshot.warningTicker,
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
