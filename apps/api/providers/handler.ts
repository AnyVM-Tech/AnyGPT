import dotenv from 'dotenv';
import {
	IAIProvider, // Keep IAIProvider if needed for ProviderConfig
	IMessage,
	ResponseEntry,
	Provider as ProviderStateStructure,
	Model,
	ModelCapability,
	ProviderResponse,
	ProviderUsage
} from './interfaces.js'; // Removed ModelDefinition from here
import { GeminiAI } from './gemini.js';
import { ImagenAI } from './imagen.js';
import { OpenAI } from './openai.js';
import { OpenRouterAI } from './openrouter.js';
import { DeepseekAI } from './deepseek.js';
import {
	updateProviderData,
	applyTimeWindow,
	calculateProviderScore
} from '../modules/compute.js';
import { computeProviderMetricsInWorker } from '../modules/workerPool.js';
// Import DataManager and necessary EXPORTED types
import {
	dataManager,
	LoadedProviders, // Import exported type
	LoadedProviderData, // Import exported type
	ModelsFileStructure, // Import exported type
	ModelDefinition // Import ModelDefinition from dataManager
} from '../modules/dataManager.js';
import { resolveSoraVideoModelId } from '../modules/openaiRouteUtils.js';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js'; // Added import
// FIX: Import fs for schema loading
import * as fs from 'fs';
import * as path from 'path';
import { Ajv } from 'ajv';
import {
	validateApiKeyAndUsage, // Now async
	UserData, // Assuming this is exported from userData
	TierData // Assuming this is exported from userData
} from '../modules/userData.js';
import { assertModelAllowedForTier } from '../modules/planAccess.js';
import { isExcludedError } from '../modules/errorExclusion.js';
import redis from '../modules/db.js';
import { hashToken } from '../modules/redaction.js';
import { logUniqueProviderError } from '../modules/errorLogger.js';
import { logMemoryProfile } from '../modules/requestIntake.js';
import {
	containsOpenAiApiKeyHelpLink,
	textMentionsHostname
} from '../modules/urlGuards.js';
import {
	readEnvNumber,
	type TokenBreakdown,
	estimateTokensFromText,
	estimateTokensFromMessagesBreakdown
} from '../modules/tokenEstimation.js';
import { RequestQueue, getRequestQueueForLane, type RequestQueueLane } from '../modules/requestQueue.js';
import {
	isRateLimitOrQuotaError as isRateLimitOrQuotaErrorShared,
	isInvalidProviderCredentialError as isInvalidProviderCredentialErrorShared,
	isModelAccessError as isModelAccessErrorShared,
	isInsufficientCreditsError as isInsufficientCreditsErrorShared,
	isToolUnsupportedError as isToolUnsupportedErrorShared,
	isProviderRequestShapeError as isProviderRequestShapeErrorShared,
	isTransientProviderGatewayError,
	extractRetryAfterMs,
	extractRateLimitRps,
	extractRateLimitWindow
} from '../modules/errorClassification.js';

dotenv.config();
const ajv = new Ajv();

const AUTO_DISABLE_PROVIDERS =
	process.env.DISABLE_PROVIDER_AUTO_DISABLE !== 'true';
const PROVIDER_AUTO_RECOVER_MS = (() => {
	const raw = process.env.PROVIDER_AUTO_RECOVER_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000; // default 10 minutes
})();
const PROVIDER_AUTO_RECOVER_MAX_MS = (() => {
	const raw = process.env.PROVIDER_AUTO_RECOVER_MAX_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000; // default 1 hour
})();
const PROVIDER_AUTO_DISABLE_MIN_ACTIVE = (() => {
	const raw = process.env.PROVIDER_AUTO_DISABLE_MIN_ACTIVE;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
})();
const RATE_LIMIT_WAIT_PER_MESSAGE = (() => {
	const raw = process.env.RATE_LIMIT_WAIT_PER_MESSAGE;
	if (raw === undefined) return true;
	const normalized = String(raw).trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
})();
const RATE_LIMIT_SKIP_WAIT = (() => {
	const raw = process.env.RATE_LIMIT_SKIP_WAIT;
	if (raw === undefined) return false;
	const normalized = String(raw).trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
})();
const PROVIDER_STATS_QUEUE_CONCURRENCY = (() => {
	const raw = process.env.PROVIDER_STATS_QUEUE_CONCURRENCY;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 1;
})();
const PROVIDER_STATS_QUEUE_WORKERS = (() => {
	const raw = process.env.PROVIDER_STATS_QUEUE_WORKERS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 1;
})();
const PROVIDER_STATS_QUEUE_MAX_PENDING = (() => {
	const raw = process.env.PROVIDER_STATS_QUEUE_MAX_PENDING;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 32;
})();
const PROVIDER_STATS_FLUSH_MS = (() => {
	const raw = process.env.PROVIDER_STATS_FLUSH_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 150;
})();
const PROVIDER_STATS_BATCH_SIZE = (() => {
	const raw = process.env.PROVIDER_STATS_BATCH_SIZE;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 32;
})();
const PROVIDER_STATS_BUFFER_MAX_PENDING = (() => {
	const suggestedDefault = Math.max(
		128,
		PROVIDER_STATS_BATCH_SIZE * 8,
		PROVIDER_STATS_QUEUE_MAX_PENDING *
			Math.max(1, PROVIDER_STATS_QUEUE_WORKERS)
	);
	const raw = process.env.PROVIDER_STATS_BUFFER_MAX_PENDING;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= PROVIDER_STATS_BATCH_SIZE
		? Math.floor(parsed)
		: suggestedDefault;
})();
const providerStatsQueues = Array.from(
	{ length: PROVIDER_STATS_QUEUE_WORKERS },
	(_value, index) =>
		new RequestQueue(PROVIDER_STATS_QUEUE_CONCURRENCY, {
			label: `provider-stats-worker-${index + 1}`,
			maxPending: PROVIDER_STATS_QUEUE_MAX_PENDING
		})
);

function getProviderStatsQueueIndex(
	providerId: string,
	modelId: string
): number {
	if (providerStatsQueues.length <= 1) return 0;
	const key = `${providerId}:${modelId}`;
	let hash = 0;
	for (let i = 0; i < key.length; i += 1) {
		hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % providerStatsQueues.length;
}

function getProviderStatsQueue(
	providerId: string,
	modelId: string
): { queue: RequestQueue; index: number } {
	const index = getProviderStatsQueueIndex(providerId, modelId);
	return {
		queue: providerStatsQueues[index] || providerStatsQueues[0],
		index
	};
}

function getProviderStatsQueueByIndex(index: number): RequestQueue {
	return providerStatsQueues[index] || providerStatsQueues[0];
}

export function getProviderStatsQueueSnapshots(): ReturnType<
	RequestQueue['snapshot']
>[] {
	return providerStatsQueues.map((queue, index) => {
		const snapshot = queue.snapshot();
		return {
			...snapshot,
			label: snapshot.label || `provider-stats-worker-${index + 1}`
		};
	});
}
const RATE_LIMIT_WAIT_MAX_MS = (() => {
	const raw = process.env.RATE_LIMIT_WAIT_MAX_MS;
	if (raw === undefined) return 2 * 60 * 1000; // default 2 minutes max wait
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 2 * 60 * 1000;
	if (parsed <= 0) return Number.POSITIVE_INFINITY;
	return Math.floor(parsed);
})();
const RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = (() => {
	const raw = process.env.RATE_LIMIT_TOTAL_WAIT_BUDGET_MS;
	if (raw === undefined) return 5_000; // default: spend at most 5s waiting across the whole request
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 5_000;
})();
const GEMINI_RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = (() => {
	const raw = process.env.GEMINI_RATE_LIMIT_TOTAL_WAIT_BUDGET_MS;
	if (raw === undefined) return 45_000;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? Math.floor(parsed)
		: 45_000;
})();
const RATE_LIMIT_WAKE_EARLY_MS = (() => {
	const raw = process.env.RATE_LIMIT_WAKE_EARLY_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2000;
})();
const PROVIDER_RATE_LIMIT_WAKE_EARLY_MS = (() => {
	const raw = process.env.PROVIDER_RATE_LIMIT_WAKE_EARLY_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	return RATE_LIMIT_WAKE_EARLY_MS;
})();
const SHARED_PROVIDER_WINDOW_SAFETY_RATIO = (() => {
	const raw = Number(process.env.SHARED_PROVIDER_WINDOW_SAFETY_RATIO ?? 0.85);
	if (!Number.isFinite(raw)) return 0.85;
	return Math.min(0.99, Math.max(0.5, raw));
})();
const SHARED_PROVIDER_WINDOW_REQUEST_RESERVE = (() => {
	const raw = Number(process.env.SHARED_PROVIDER_WINDOW_REQUEST_RESERVE ?? 1);
	if (!Number.isFinite(raw) || raw < 0) return 1;
	return Math.floor(raw);
})();
const SHARED_PROVIDER_WINDOW_JITTER_MS = (() => {
	const raw = Number(process.env.SHARED_PROVIDER_WINDOW_JITTER_MS ?? 1500);
	if (!Number.isFinite(raw) || raw < 0) return 1500;
	return Math.floor(raw);
})();
const SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS = (() => {
	const raw = Number(
		process.env.SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS ?? 350
	);
	if (!Number.isFinite(raw) || raw < 0) return 350;
	return Math.floor(raw);
})();
const SHARED_PROVIDER_BURST_GAP_MS = (() => {
	const raw = Number(process.env.SHARED_PROVIDER_BURST_GAP_MS ?? 5000);
	if (!Number.isFinite(raw) || raw < 250) return 5000;
	return Math.floor(raw);
})();
const REQUEST_DEADLINE_MS = (() => {
	const raw = process.env.REQUEST_DEADLINE_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; // default disabled (no request-level timeout)
})();
const PROVIDER_STREAM_IDLE_TIMEOUT_MS = (() => {
	const raw = process.env.PROVIDER_STREAM_IDLE_TIMEOUT_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1_000, Math.floor(parsed))
		: 90_000;
})();
const FALLBACK_ATTEMPT_TIMEOUT_MS = (() => {
	const raw = process.env.FALLBACK_ATTEMPT_TIMEOUT_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000; // default 15 seconds for disabled fallback attempts
})();
const TTFT_INPUT_TOKENS_WEIGHT = (() => {
	const raw = process.env.TTFT_INPUT_TOKENS_WEIGHT;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();
const TTFT_OUTPUT_TOKENS_WEIGHT = (() => {
	const raw = process.env.TTFT_OUTPUT_TOKENS_WEIGHT;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();
const NON_STREAM_MIN_GENERATION_WINDOW_MS = (() => {
	const raw = process.env.NON_STREAM_MIN_GENERATION_WINDOW_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
})();
const NON_STREAM_MIN_TTFT_MS = (() => {
	const raw = process.env.NON_STREAM_MIN_TTFT_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 25;
})();
const PROVIDER_COOLDOWN_MS = Math.max(
	0,
	Number(process.env.PROVIDER_COOLDOWN_MS ?? 60_000)
);
const PROVIDER_MIN_ACTIVE_MODEL_CANDIDATES = (() => {
	const raw = Number(process.env.PROVIDER_MIN_ACTIVE_MODEL_CANDIDATES ?? 6);
	if (!Number.isFinite(raw) || raw <= 0) return 6;
	return Math.max(1, Math.floor(raw));
})();
const PROVIDER_SELECTION_LATENCY_WEIGHT = 0.7;
const PROVIDER_SELECTION_ERROR_WEIGHT = 0.3;
const PROVIDER_SELECTION_DEGRADED_SCORE = (() => {
	const raw = Number(process.env.PROVIDER_SELECTION_DEGRADED_SCORE ?? 20);
	if (!Number.isFinite(raw)) return 20;
	return Math.max(0, Math.min(100, Math.round(raw)));
})();
const PROVIDER_COOLDOWN_REDIS_PREFIX = 'provider:cooldown:';
const PROVIDER_DISTRIBUTED_SCHEDULER_ENABLED =
	process.env.PROVIDER_DISTRIBUTED_SCHEDULER !== '0';
const PROVIDER_DISTRIBUTED_BUCKET_REDIS_PREFIX = 'provider:scheduler:bucket:';
const PROVIDER_DISTRIBUTED_COOLDOWN_REDIS_PREFIX =
	'provider:scheduler:cooldown:';
const PROVIDER_DISTRIBUTED_LEASE_REDIS_PREFIX = 'provider:scheduler:lease:';
const PROVIDER_DISTRIBUTED_LEASE_MS = Math.max(
	100,
	Number(process.env.PROVIDER_DISTRIBUTED_LEASE_MS ?? 1000)
);
const PROVIDER_AUTH_FAILURE_FAST_SKIP_MS = (() => {
	const raw = process.env.PROVIDER_AUTH_FAILURE_FAST_SKIP_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 10 * 60 * 1000;
})();
const PROVIDER_LIVE_AUTONOMOUS_TRANSIENT_SKIP_MS = (() => {
	const raw = process.env.PROVIDER_LIVE_AUTONOMOUS_TRANSIENT_SKIP_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 5 * 60 * 1000;
})();
const PROVIDER_LIVE_AUTONOMOUS_COOLDOWN_SKIP_MS = (() => {
	const raw = process.env.PROVIDER_LIVE_AUTONOMOUS_COOLDOWN_SKIP_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 2 * 60 * 1000;
})();
const PROVIDER_QUOTA_REENABLE_CANDIDATE_LIMIT = (() => {
	const raw = process.env.PROVIDER_QUOTA_REENABLE_CANDIDATE_LIMIT;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 100;
})();
const PROVIDER_HEALTH_FILTER_BREADTH_TARGET = (() => {
	const raw = process.env.PROVIDER_HEALTH_FILTER_BREADTH_TARGET;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 16;
})();
const GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST = (() => {
	const raw = process.env.GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.max(1, Math.floor(parsed))
		: 12;
})();
const GEMINI_MODEL_NEGATIVE_CACHE_RATE_LIMIT_FLOOR_MS = (() => {
	const raw = process.env.GEMINI_MODEL_NEGATIVE_CACHE_RATE_LIMIT_FLOOR_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 15_000;
})();
const GEMINI_MODEL_NEGATIVE_CACHE_ZERO_QUOTA_FLOOR_MS = (() => {
	const raw = process.env.GEMINI_MODEL_NEGATIVE_CACHE_ZERO_QUOTA_FLOOR_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 60_000;
})();
const GEMINI_MODEL_NEGATIVE_CACHE_NOT_FOUND_MS = (() => {
	const raw = process.env.GEMINI_MODEL_NEGATIVE_CACHE_NOT_FOUND_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 60 * 60 * 1000;
})();
const providerCooldowns = new Map<string, number>();
const providerDistributedCooldowns = new Map<string, number>();
const providerRateLimitStarts = new Map<string, number>();
const providerRateLimitWindows = new Map<string, number[]>();
const providerFastSkips = new Map<string, number>();
type ModelNegativeCacheEntry = {
	family: 'gemini';
	modelId: string;
	reason: 'rate_limit' | 'model_not_found';
	statusCode: 429 | 404;
	code: 'GEMINI_MODEL_RATE_LIMITED' | 'model_not_found';
	message: string;
	retryAfterMs?: number;
	expiresAt: number;
};
const modelNegativeCaches = new Map<string, ModelNegativeCacheEntry>();
const COOLDOWN_EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Sweep expired entries every 5 minutes
const MODEL_NEGATIVE_CACHE_REDIS_PREFIX = 'provider:model-negative:';
const PROVIDER_RATE_LIMIT_TRACKING_TTL_MS = (() => {
	const fallback = Number.isFinite(RATE_LIMIT_WAIT_MAX_MS)
		? Math.max(10 * 60 * 1000, Math.floor(RATE_LIMIT_WAIT_MAX_MS * 4))
		: 10 * 60 * 1000;
	const raw = Number(
		process.env.PROVIDER_RATE_LIMIT_TRACKING_TTL_MS ?? fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const DISTRIBUTED_PROVIDER_BUCKET_LUA = `
local bucket_key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_ms = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local tokens = tonumber(redis.call('HGET', bucket_key, 'tokens'))
local ts = tonumber(redis.call('HGET', bucket_key, 'ts'))

if not tokens then tokens = capacity end
if not ts then ts = now_ms end

if refill_ms and refill_ms > 0 then
  local elapsed = math.max(0, now_ms - ts)
  if elapsed > 0 then
    local refill = elapsed / refill_ms
    tokens = math.min(capacity, tokens + refill)
    ts = now_ms
  end
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', bucket_key, 'tokens', tostring(tokens), 'ts', tostring(ts))
  redis.call('PEXPIRE', bucket_key, ttl_ms)
  return {1, 0}
end

local wait_ms = ttl_ms
if refill_ms and refill_ms > 0 then
  wait_ms = math.ceil((1 - tokens) * refill_ms)
end

redis.call('HSET', bucket_key, 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', bucket_key, ttl_ms)
return {0, wait_ms}
`;

// Periodic eviction to prevent unbounded Map growth
const _cooldownEvictionTimer = setInterval(() => {
	const now = Date.now();
	let evicted = 0;
	for (const [key, expiresAt] of providerCooldowns) {
		if (expiresAt <= now) {
			providerCooldowns.delete(key);
			evicted++;
		}
	}
	for (const [key, expiresAt] of providerDistributedCooldowns) {
		if (expiresAt <= now) {
			providerDistributedCooldowns.delete(key);
			evicted++;
		}
	}
	for (const [key, expiresAt] of providerFastSkips) {
		if (expiresAt <= now) {
			providerFastSkips.delete(key);
			evicted++;
		}
	}
	for (const [key, startedAt] of providerRateLimitStarts) {
		if (now - startedAt >= PROVIDER_RATE_LIMIT_TRACKING_TTL_MS) {
			providerRateLimitStarts.delete(key);
			evicted++;
		}
	}
	for (const [key, timestamps] of providerRateLimitWindows) {
		if (!Array.isArray(timestamps) || timestamps.length === 0) {
			providerRateLimitWindows.delete(key);
			evicted++;
			continue;
		}
		const active = timestamps.filter(
			timestamp => now - timestamp < PROVIDER_RATE_LIMIT_TRACKING_TTL_MS
		);
		if (active.length > 0) {
			if (active.length !== timestamps.length) {
				providerRateLimitWindows.set(key, active);
			}
		} else {
			providerRateLimitWindows.delete(key);
			evicted++;
		}
	}
	for (const [key, entry] of modelNegativeCaches) {
		if (!entry || entry.expiresAt <= now) {
			modelNegativeCaches.delete(key);
			evicted++;
		}
	}
	if (evicted > 0) {
		console.log(
			`[CooldownEviction] Swept ${evicted} expired cooldown/rate-limit entries. ` +
				`Remaining cooldowns=${providerCooldowns.size}, rateWindows=${providerRateLimitWindows.size}, modelNegativeCaches=${modelNegativeCaches.size}`
		);
	}
}, COOLDOWN_EVICTION_INTERVAL_MS);
if (typeof (_cooldownEvictionTimer as any).unref === 'function')
	(_cooldownEvictionTimer as any).unref();

function getCooldownKey(key: string): string {
	return `${PROVIDER_COOLDOWN_REDIS_PREFIX}${hashToken(key)}`;
}

// extractRetryAfterMs is now imported from '../modules/errorClassification.js'

function buildModelNegativeCacheIdentity(
	family: 'gemini',
	modelId: string
): string {
	return `${family}::${String(modelId || '').toLowerCase()}`;
}

function getModelNegativeCacheRedisKey(
	family: 'gemini',
	modelId: string
): string {
	return `${MODEL_NEGATIVE_CACHE_REDIS_PREFIX}${hashToken(buildModelNegativeCacheIdentity(family, modelId))}`;
}

function cloneModelNegativeCacheEntry(
	entry: ModelNegativeCacheEntry
): ModelNegativeCacheEntry {
	return {
		...entry,
		modelId: String(entry.modelId || '').toLowerCase(),
	};
}

async function getModelNegativeCacheEntry(
	family: 'gemini',
	modelId: string
): Promise<ModelNegativeCacheEntry | null> {
	const identity = buildModelNegativeCacheIdentity(family, modelId);
	const now = Date.now();
	const cached = modelNegativeCaches.get(identity);
	if (cached) {
		if (cached.expiresAt > now) {
			return cloneModelNegativeCacheEntry(cached);
		}
		modelNegativeCaches.delete(identity);
	}

	if (!redis || redis.status !== 'ready') return null;
	try {
		const raw = await redis.get(getModelNegativeCacheRedisKey(family, modelId));
		if (!raw) return null;
		const parsed = JSON.parse(String(raw || '')) as Partial<ModelNegativeCacheEntry>;
		const expiresAt = Number(parsed?.expiresAt || 0);
		if (!Number.isFinite(expiresAt) || expiresAt <= now) {
			return null;
		}
		const entry: ModelNegativeCacheEntry = {
			family: 'gemini',
			modelId: String(parsed?.modelId || modelId).toLowerCase(),
			reason:
				parsed?.reason === 'model_not_found'
					? 'model_not_found'
					: 'rate_limit',
			statusCode: parsed?.statusCode === 404 ? 404 : 429,
			code:
				parsed?.code === 'model_not_found'
					? 'model_not_found'
					: 'GEMINI_MODEL_RATE_LIMITED',
			message: String(parsed?.message || '').trim() || 'Gemini model temporarily unavailable.',
			...(Number.isFinite(parsed?.retryAfterMs as number) &&
			(parsed?.retryAfterMs as number) > 0
				? { retryAfterMs: Math.max(1, Math.ceil(parsed?.retryAfterMs as number)) }
				: {}),
			expiresAt,
		};
		modelNegativeCaches.set(identity, entry);
		return cloneModelNegativeCacheEntry(entry);
	} catch {
		return null;
	}
}

async function setModelNegativeCacheEntry(
	entry: Omit<ModelNegativeCacheEntry, 'expiresAt'>,
	ttlMs: number
): Promise<void> {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
	const normalizedTtlMs = Math.max(1, Math.ceil(ttlMs));
	const normalizedEntry: ModelNegativeCacheEntry = {
		...entry,
		modelId: String(entry.modelId || '').toLowerCase(),
		expiresAt: Date.now() + normalizedTtlMs,
	};
	const identity = buildModelNegativeCacheIdentity(
		normalizedEntry.family,
		normalizedEntry.modelId
	);
	modelNegativeCaches.set(identity, normalizedEntry);
	if (!redis || redis.status !== 'ready') return;
	try {
		await redis.set(
			getModelNegativeCacheRedisKey(
				normalizedEntry.family,
				normalizedEntry.modelId
			),
			JSON.stringify(normalizedEntry),
			'PX',
			String(normalizedTtlMs)
		);
	} catch {
		return;
	}
}

async function clearModelNegativeCacheEntry(
	family: 'gemini',
	modelId: string
): Promise<void> {
	const identity = buildModelNegativeCacheIdentity(family, modelId);
	modelNegativeCaches.delete(identity);
	if (!redis || redis.status !== 'ready') return;
	try {
		await redis.del(getModelNegativeCacheRedisKey(family, modelId));
	} catch {
		return;
	}
}

function buildCooldownKey(apiKey: string, modelId: string): string {
	return `${hashToken(apiKey)}::${String(modelId || '').toLowerCase()}`;
}

function getProviderRateLimitKey(providerId: string, modelId: string): string {
	return `${providerId}::${String(modelId || '').toLowerCase()}`;
}

function getDistributedProviderIdentity(
	providerId: string,
	modelId: string
): string {
	return `${String(providerId || '').toLowerCase()}::${String(modelId || '').toLowerCase()}`;
}

function getDistributedProviderBucketKey(
	providerId: string,
	modelId: string
): string {
	return `${PROVIDER_DISTRIBUTED_BUCKET_REDIS_PREFIX}${hashToken(getDistributedProviderIdentity(providerId, modelId))}`;
}

function getDistributedProviderCooldownKey(
	providerId: string,
	modelId: string
): string {
	return `${PROVIDER_DISTRIBUTED_COOLDOWN_REDIS_PREFIX}${hashToken(getDistributedProviderIdentity(providerId, modelId))}`;
}

function getDistributedProviderLeaseKey(
	providerId: string,
	modelId: string
): string {
	return `${PROVIDER_DISTRIBUTED_LEASE_REDIS_PREFIX}${hashToken(getDistributedProviderIdentity(providerId, modelId))}`;
}

function getProviderFastSkipRemainingMs(providerId: string): number | null {
	const expiresAt = providerFastSkips.get(providerId);
	if (!expiresAt) return null;
	const remainingMs = expiresAt - Date.now();
	if (remainingMs <= 0) {
		providerFastSkips.delete(providerId);
		return null;
	}
	return remainingMs;
}

function markProviderFastSkip(
	providerId: string,
	reason?: string,
	ttlMs: number = PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
): void {
	if (!providerId || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
	const nextExpiresAt = Date.now() + Math.max(1, Math.ceil(ttlMs));
	const previousExpiresAt = providerFastSkips.get(providerId) ?? 0;
	if (previousExpiresAt >= nextExpiresAt) return;
	providerFastSkips.set(providerId, nextExpiresAt);
	const suffix = reason ? ` (${String(reason).slice(0, 200)})` : '';
	console.warn(
		`[ProviderFastSkip] Temporarily skipping ${providerId} for ${Math.round(ttlMs / 1000)}s${suffix}`
	);
}

function clearProviderFastSkip(providerId: string): void {
	if (!providerId) return;
	providerFastSkips.delete(providerId);
}

function summarizeProviderStateErrorMessage(error: any): string | undefined {
	const raw =
		typeof error?.message === 'string' && error.message.trim().length > 0
			? error.message
			: (typeof error === 'string' && error.trim().length > 0
				? error
				: '');
	if (!raw) return undefined;
	return raw.length <= 4000 ? raw : `${raw.slice(0, 3997)}...`;
}

function getProviderStateErrorCode(error: any): string | undefined {
	const raw = error?.code ?? error?.errorDetails?.code;
	if (raw === undefined || raw === null) return undefined;
	const code = String(raw).trim();
	return code.length > 0 ? code.slice(0, 200) : undefined;
}

function getProviderStateErrorStatus(error: any): number | null {
	const raw = Number(
		error?.status ??
			error?.statusCode ??
			error?.response?.status ??
			error?.errorDetails?.statusCode ??
			0
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

function isSharedRateLimitProvider(providerId: string): boolean {
	const normalized = String(providerId || '').toLowerCase();
	// Default to treating providers as shared-rate-limit backends unless they are
	// clearly local/dedicated. This is safer for hosted providers where limits
	// can drift due to other traffic outside this process.
	if (!normalized) return true;
	if (normalized.includes('ollama')) return false;
	if (normalized.includes('mock')) return false;
	if (normalized.includes('local')) return false;
	return true;
}

function getEffectiveWindowBudget(
	providerId: string,
	rateLimitRequests: number
): number {
	const rawBudget = Math.max(1, Math.floor(rateLimitRequests));
	if (!isSharedRateLimitProvider(providerId)) return rawBudget;
	const scaledBudget = Math.max(
		1,
		Math.floor(rawBudget * SHARED_PROVIDER_WINDOW_SAFETY_RATIO)
	);
	const reservedBudget = Math.max(
		1,
		rawBudget -
			Math.min(
				SHARED_PROVIDER_WINDOW_REQUEST_RESERVE,
				Math.max(0, rawBudget - 1)
			)
	);
	return Math.max(1, Math.min(scaledBudget, reservedBudget));
}

function resolveDistributedProviderRateDescriptor(
	providerId: string,
	modelStats?: any
): { capacity: number; refillMs: number; ttlMs: number } | null {
	const rateLimitRps = Number(modelStats?.rate_limit_rps);
	const rateLimitRequests = Number(modelStats?.rate_limit_requests);
	const rateLimitWindowMs = Number(modelStats?.rate_limit_window_ms);
	const hasRps = Number.isFinite(rateLimitRps) && rateLimitRps > 0;
	const hasWindowBudget =
		Number.isFinite(rateLimitRequests) &&
		rateLimitRequests > 0 &&
		Number.isFinite(rateLimitWindowMs) &&
		rateLimitWindowMs > 0;

	if (!hasRps && !hasWindowBudget) return null;

	if (hasWindowBudget) {
		const capacity = getEffectiveWindowBudget(
			providerId,
			rateLimitRequests
		);
		const refillMs = Math.max(
			1,
			Math.ceil(rateLimitWindowMs / Math.max(1, capacity))
		);
		const ttlMs = Math.max(60_000, Math.ceil(rateLimitWindowMs * 2));
		return { capacity, refillMs, ttlMs };
	}

	const safeRps = Math.max(0.001, rateLimitRps);
	const sharedCapacity = isSharedRateLimitProvider(providerId)
		? Math.max(1, Math.floor(safeRps * SHARED_PROVIDER_WINDOW_SAFETY_RATIO))
		: Math.max(1, Math.floor(safeRps));
	const capacity = Math.max(1, sharedCapacity);
	const refillMs = Math.max(1, Math.ceil(1000 / safeRps));
	const ttlMs = Math.max(60_000, capacity * refillMs * 8);
	return { capacity, refillMs, ttlMs };
}

function pruneProviderRateLimitWindow(
	providerId: string,
	modelId: string,
	windowMs: number,
	now: number = Date.now()
): number[] {
	if (!Number.isFinite(windowMs) || windowMs <= 0) return [];
	const key = getProviderRateLimitKey(providerId, modelId);
	const entries = providerRateLimitWindows.get(key);
	if (!entries || entries.length === 0) return [];
	const active = entries.filter(timestamp => now - timestamp < windowMs);
	if (active.length > 0) {
		providerRateLimitWindows.set(key, active);
	} else {
		providerRateLimitWindows.delete(key);
	}
	return active;
}

function getProviderRateLimitWaitMs(
	providerId: string,
	modelId: string,
	rateLimitRps?: number | null,
	rateLimitRequests?: number | null,
	rateLimitWindowMs?: number | null
): { waitMs: number; earlyWakeMs: number | null } {
	const hasRps =
		Number.isFinite(rateLimitRps as number) && (rateLimitRps as number) > 0;
	const hasWindowBudget =
		Number.isFinite(rateLimitRequests as number) &&
		(rateLimitRequests as number) > 0 &&
		Number.isFinite(rateLimitWindowMs as number) &&
		(rateLimitWindowMs as number) > 0;
	if (!hasRps && !hasWindowBudget) {
		return { waitMs: 0, earlyWakeMs: null };
	}
	const key = getProviderRateLimitKey(providerId, modelId);
	const now = Date.now();
	let rawWaitMs = 0;

	if (hasRps) {
		const rps = Math.max(0.001, Number(rateLimitRps));
		const intervalMs = Math.max(1, Math.floor(1000 / rps));
		const lastStart = providerRateLimitStarts.get(key);
		if (lastStart) {
			rawWaitMs = Math.max(rawWaitMs, lastStart + intervalMs - now);
		}
	}

	if (hasWindowBudget) {
		const allowedRequests = getEffectiveWindowBudget(
			providerId,
			Number(rateLimitRequests)
		);
		const windowMs = Math.max(1, Math.ceil(Number(rateLimitWindowMs)));
		const activeStarts = pruneProviderRateLimitWindow(
			providerId,
			modelId,
			windowMs,
			now
		);
		if (activeStarts.length >= allowedRequests) {
			const releaseIndex = Math.max(
				0,
				activeStarts.length - allowedRequests
			);
			rawWaitMs = Math.max(
				rawWaitMs,
				activeStarts[releaseIndex] + windowMs - now
			);
		}
	}

	if (rawWaitMs <= 0) return { waitMs: 0, earlyWakeMs: null };
	const cappedWaitMs = Math.min(rawWaitMs, RATE_LIMIT_WAIT_MAX_MS);
	const configuredEarlyWakeMs = isSharedRateLimitProvider(providerId)
		? 0
		: Math.max(0, PROVIDER_RATE_LIMIT_WAKE_EARLY_MS);
	const earlyWakeMs = Math.min(
		Math.max(0, cappedWaitMs - 1),
		configuredEarlyWakeMs
	);
	return { waitMs: cappedWaitMs, earlyWakeMs };
}

function markProviderRateLimitStart(providerId: string, modelId: string): void {
	const key = getProviderRateLimitKey(providerId, modelId);
	const now = Date.now();
	providerRateLimitStarts.set(key, now);
	const timestamps = providerRateLimitWindows.get(key) ?? [];
	timestamps.push(now);
	if (timestamps.length > 2048) {
		timestamps.splice(0, timestamps.length - 2048);
	}
	providerRateLimitWindows.set(key, timestamps);
}

function estimateRateLimitRequestsFromBurst(
	providerId: string,
	modelId: string,
	cooldownMs: number
): number | null {
	if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return null;
	const key = getProviderRateLimitKey(providerId, modelId);
	const timestamps = providerRateLimitWindows.get(key);
	if (!timestamps || timestamps.length <= 1) return null;

	const recentHorizonMs = Math.max(Math.ceil(cooldownMs * 6), 60_000);
	const cutoff = Date.now() - recentHorizonMs;
	const recent = timestamps.filter(timestamp => timestamp >= cutoff);
	if (recent.length <= 1) return null;

	const burstGapMs = isSharedRateLimitProvider(providerId)
		? Math.min(
				SHARED_PROVIDER_BURST_GAP_MS,
				Math.max(1000, Math.ceil(cooldownMs * 0.1))
			)
		: Math.min(10_000, Math.max(1000, Math.ceil(cooldownMs * 0.25)));
	let burstCount = 1;
	for (let i = recent.length - 1; i > 0; i--) {
		const gapMs = recent[i] - recent[i - 1];
		if (gapMs > burstGapMs) break;
		burstCount += 1;
	}

	const successfulBeforeLimit = Math.max(1, burstCount - 1);
	return successfulBeforeLimit;
}

function normalizeRetryAfterCooldownMs(
	providerId: string,
	retryAfterMs: number | null | undefined
): number | null {
	if (
		!Number.isFinite(retryAfterMs as number) ||
		(retryAfterMs as number) <= 0
	)
		return null;
	const baseMs = Math.max(1, Math.ceil(retryAfterMs as number));
	if (!isSharedRateLimitProvider(providerId)) return baseMs;
	return baseMs + SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS;
}

function resolveProviderCooldownMs(
	providerId: string,
	modelStats: any,
	retryAfterMs: number | null | undefined
): number | null {
	const explicitCooldownMs = normalizeRetryAfterCooldownMs(
		providerId,
		retryAfterMs
	);
	if (explicitCooldownMs && explicitCooldownMs > 0) {
		return explicitCooldownMs;
	}

	const rateLimitWindowMs = Number(modelStats?.rate_limit_window_ms ?? 0);
	if (Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0) {
		const boundedWindowMs = Math.max(
			1_000,
			Math.min(PROVIDER_COOLDOWN_MS, Math.ceil(rateLimitWindowMs))
		);
		return isSharedRateLimitProvider(providerId)
			? boundedWindowMs + SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS
			: boundedWindowMs;
	}

	const rateLimitRps = Number(modelStats?.rate_limit_rps ?? 0);
	if (Number.isFinite(rateLimitRps) && rateLimitRps > 0) {
		const perRequestMs = Math.max(1_000, Math.ceil(1_000 / rateLimitRps));
		return Math.min(PROVIDER_COOLDOWN_MS, perRequestMs);
	}

	return null;
}

function smoothPositiveInteger(
	previousValue: number | null | undefined,
	nextValue: number
): number {
	const next = Math.max(1, Math.round(nextValue));
	if (
		!Number.isFinite(previousValue as number) ||
		(previousValue as number) <= 0
	)
		return next;
	return Math.max(1, Math.round(((previousValue as number) + next) / 2));
}

async function isApiKeyCoolingDownForModel(
	apiKey: string,
	modelId: string
): Promise<boolean> {
	if (!apiKey || PROVIDER_COOLDOWN_MS <= 0) return false;
	const key = buildCooldownKey(apiKey, modelId);
	const now = Date.now();
	const cachedUntil = providerCooldowns.get(key);
	if (cachedUntil && cachedUntil > now) return true;
	if (cachedUntil && cachedUntil <= now) providerCooldowns.delete(key);

	if (!redis || redis.status !== 'ready') return false;
	try {
		const ttlMs = await redis.pttl(getCooldownKey(`${apiKey}::${modelId}`));
		if (ttlMs > 0) {
			providerCooldowns.set(key, now + ttlMs);
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

async function getDistributedProviderCooldownMs(
	providerId: string,
	modelId: string
): Promise<number | null> {
	if (
		!PROVIDER_DISTRIBUTED_SCHEDULER_ENABLED ||
		!isSharedRateLimitProvider(providerId)
	)
		return null;
	const key = getDistributedProviderIdentity(providerId, modelId);
	const now = Date.now();
	const cachedUntil = providerDistributedCooldowns.get(key);
	if (cachedUntil) {
		const remaining = cachedUntil - now;
		if (remaining > 0) return remaining;
		providerDistributedCooldowns.delete(key);
	}

	if (!redis || redis.status !== 'ready') return null;
	try {
		const ttlMs = await redis.pttl(
			getDistributedProviderCooldownKey(providerId, modelId)
		);
		if (ttlMs > 0) {
			providerDistributedCooldowns.set(key, now + ttlMs);
			return ttlMs;
		}
	} catch {
		return null;
	}
	return null;
}

async function setDistributedProviderCooldown(
	providerId: string,
	modelId: string,
	overrideMs?: number
): Promise<void> {
	if (
		!PROVIDER_DISTRIBUTED_SCHEDULER_ENABLED ||
		!isSharedRateLimitProvider(providerId)
	)
		return;
	const cooldownMs =
		Number.isFinite(overrideMs as number) && (overrideMs as number) > 0
			? Math.max(1, Math.ceil(overrideMs as number))
			: PROVIDER_COOLDOWN_MS;
	if (cooldownMs <= 0) return;
	const key = getDistributedProviderIdentity(providerId, modelId);
	providerDistributedCooldowns.set(key, Date.now() + cooldownMs);
	if (!redis || redis.status !== 'ready') return;
	try {
		await redis.set(
			getDistributedProviderCooldownKey(providerId, modelId),
			'1',
			'PX',
			String(cooldownMs)
		);
	} catch {
		return;
	}
}

async function acquireDistributedProviderPermit(
	providerId: string,
	modelId: string,
	modelStats?: any
): Promise<{ allowed: boolean; waitMs: number }> {
	if (
		!PROVIDER_DISTRIBUTED_SCHEDULER_ENABLED ||
		!isSharedRateLimitProvider(providerId)
	) {
		return { allowed: true, waitMs: 0 };
	}
	if (!redis || redis.status !== 'ready') {
		return { allowed: true, waitMs: 0 };
	}

	const descriptor = resolveDistributedProviderRateDescriptor(
		providerId,
		modelStats
	);
	if (!descriptor) {
		const fallbackLeaseMs = Math.max(100, PROVIDER_DISTRIBUTED_LEASE_MS);
		try {
			const leaseKey = getDistributedProviderLeaseKey(
				providerId,
				modelId
			);
			const leaseToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
			const result = await redis.set(
				leaseKey,
				leaseToken,
				'PX',
				String(fallbackLeaseMs),
				'NX'
			);
			if (result === 'OK') {
				return { allowed: true, waitMs: 0 };
			}
			const ttlMs = await redis.pttl(leaseKey);
			return {
				allowed: false,
				waitMs: ttlMs > 0 ? ttlMs : fallbackLeaseMs
			};
		} catch {
			return { allowed: true, waitMs: 0 };
		}
	}

	try {
		const result = await redis.eval(
			DISTRIBUTED_PROVIDER_BUCKET_LUA,
			1,
			getDistributedProviderBucketKey(providerId, modelId),
			String(Date.now()),
			String(descriptor.capacity),
			String(descriptor.refillMs),
			String(descriptor.ttlMs)
		);
		const parts = Array.isArray(result) ? result : [];
		const allowed = Number(parts[0] ?? 1) === 1;
		const waitMs = Math.max(0, Number(parts[1] ?? 0));
		return { allowed, waitMs };
	} catch {
		return { allowed: true, waitMs: 0 };
	}
}

async function getApiKeyCooldownMsForModel(
	apiKey: string,
	modelId: string
): Promise<number | null> {
	if (!apiKey || PROVIDER_COOLDOWN_MS <= 0) return null;
	const key = buildCooldownKey(apiKey, modelId);
	const now = Date.now();
	const cachedUntil = providerCooldowns.get(key);
	if (cachedUntil) {
		const remaining = cachedUntil - now;
		if (remaining > 0) return remaining;
		providerCooldowns.delete(key);
	}

	if (!redis || redis.status !== 'ready') return null;
	try {
		const ttlMs = await redis.pttl(getCooldownKey(`${apiKey}::${modelId}`));
		if (ttlMs > 0) {
			providerCooldowns.set(key, now + ttlMs);
			return ttlMs;
		}
	} catch {
		return null;
	}
	return null;
}

async function setApiKeyCooldownForModel(
	apiKey: string,
	modelId: string,
	overrideMs?: number
): Promise<void> {
	const cooldownMs =
		Number.isFinite(overrideMs as number) && (overrideMs as number) > 0
			? Math.max(1, Math.ceil(overrideMs as number))
			: PROVIDER_COOLDOWN_MS;
	if (!apiKey || cooldownMs <= 0) return;
	const key = buildCooldownKey(apiKey, modelId);
	const until = Date.now() + cooldownMs;
	providerCooldowns.set(key, until);
	if (!redis || redis.status !== 'ready') return;
	try {
		await redis.set(
			getCooldownKey(`${apiKey}::${modelId}`),
			'1',
			'PX',
			String(cooldownMs)
		);
	} catch {
		return;
	}
}

function isZeroQuotaError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	if (!message.includes('limit: 0')) return false;
	return (
		message.includes('free_tier') ||
		message.includes('free tier') ||
		message.includes('quota exceeded')
	);
}

async function waitForCooldownOrDeadline(
	cooldownMs: number | null,
	requestStartTime: number,
	deadlineMs: number,
	forceWait: boolean = false,
	earlyWakeMs?: number | null
): Promise<boolean> {
	if (RATE_LIMIT_SKIP_WAIT && !forceWait) return false;
	const hasExplicitCooldown =
		Number.isFinite(cooldownMs as number) && (cooldownMs as number) > 0;
	if (!RATE_LIMIT_WAIT_PER_MESSAGE && !hasExplicitCooldown) return false;
	const baseDelay = hasExplicitCooldown
		? Math.ceil(cooldownMs as number)
		: PROVIDER_COOLDOWN_MS;
	if (baseDelay <= 0) return false;
	const earlyWake = hasExplicitCooldown
		? earlyWakeMs === undefined
			? Math.max(0, Math.floor(RATE_LIMIT_WAKE_EARLY_MS))
			: Math.max(0, Math.floor(earlyWakeMs ?? 0))
		: 0;
	const adjustedDelay = Math.max(0, baseDelay - earlyWake);
	const cappedDelay = Math.min(adjustedDelay, RATE_LIMIT_WAIT_MAX_MS);
	const remaining =
		deadlineMs > 0
			? deadlineMs - (Date.now() - requestStartTime)
			: Number.POSITIVE_INFINITY;
	if (remaining <= 0) return false;
	// If the cooldown is already within the early-wake window, do not fail the
	// request. Treat it as an immediate wake-up so the caller retries provider
	// selection right away instead of surfacing a premature 429/503.
	if (cappedDelay <= 0) return true;
	const waitMs = Math.min(cappedDelay, Math.max(0, remaining));
	if (waitMs <= 0) return false;
	await new Promise(resolve => setTimeout(resolve, waitMs));
	return true;
}
const STREAM_MIN_GENERATION_WINDOW_MS = (() => {
	const raw = process.env.STREAM_MIN_GENERATION_WINDOW_MS;
	const parsed = raw !== undefined ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
})();

// --- Paths & Schemas ---
const providersSchemaPath = path.resolve('providers.schema.json');
const modelsSchemaPath = path.resolve('models.schema.json');

let providersSchema, modelsSchema;
try {
	// Use fs directly for schema loading at startup
	providersSchema = JSON.parse(fs.readFileSync(providersSchemaPath, 'utf8'));
	modelsSchema = JSON.parse(fs.readFileSync(modelsSchemaPath, 'utf8'));
} catch (error) {
	console.error('Failed to load/parse schemas:', error);
	throw error;
}
const validateProviders = ajv.compile(providersSchema);
const validateModels = ajv.compile(modelsSchema);

// --- Interfaces ---
interface ProviderConfig {
	class: new (...args: any[]) => IAIProvider;
	args?: any[];
}

interface PendingProviderStatsUpdate {
	providerId: string;
	modelId: string;
	responseEntry: ResponseEntry | null;
	isError: boolean;
	attemptError?: any;
}

interface HandleMessagesOptions extends Partial<IMessage> {
	requestId?: string;
	skipQueue?: boolean;
	queueLane?: RequestQueueLane;
	rateLimitWaitBudgetMs?: number;
	allowStaleCooldownProbe?: boolean;
}

interface HandleStreamingOptions extends Partial<IMessage> {
	disablePassthrough?: boolean;
	requestId?: string;
	skipQueue?: boolean;
	queueLane?: RequestQueueLane;
	rateLimitWaitBudgetMs?: number;
	allowStaleCooldownProbe?: boolean;
}

let providerConfigs: { [providerId: string]: ProviderConfig } = {};
let initialModelThroughputMap: Map<string, number> = new Map();
let modelCapabilitiesMap: Map<string, ModelCapability[]> = new Map();
let messageHandler: MessageHandler;
let handlerDataInitialized = false; // Flag to track initialization

// --- Initialization using DataManager ---
export async function initializeHandlerData() {
	if (handlerDataInitialized) {
		console.log('Handler data already initialized. Skipping.');
		return;
	}
	console.log('Initializing handler data (first run)...');
	const modelsFileData =
		await dataManager.load<ModelsFileStructure>('models');
	const modelData = modelsFileData.data;

	initialModelThroughputMap = new Map<string, number>();
	modelCapabilitiesMap = new Map<string, ModelCapability[]>();
	modelData.forEach((model: ModelDefinition) => {
		const throughputValue = model.throughput;
		const throughput =
			throughputValue != null && !isNaN(Number(throughputValue))
				? Number(throughputValue)
				: NaN;
		if (model.id && !isNaN(throughput))
			initialModelThroughputMap.set(model.id, throughput);
		const caps = Array.isArray(model.capabilities)
			? (model.capabilities as ModelCapability[])
			: [];
		modelCapabilitiesMap.set(model.id, caps);
	});

	const initialProviders =
		await dataManager.load<LoadedProviders>('providers');
	console.log('Initializing provider class configurations...');
	providerConfigs = {};
	initialProviders.forEach((p: LoadedProviderData) => {
		const key = p.apiKey;
		const url = p.provider_url || '';
		if (!key)
			console.warn(
				`API key missing for provider config: ${p.id}. This provider may not function correctly if an API key is required and not defined in providers.json.`
			);

		// For Gemini we pass only the API key here; the model is injected per-request so the right modelId is used.
		if (p.id.includes('openai'))
			providerConfigs[p.id] = { class: OpenAI, args: [key, url] };
		else if (p.id.includes('openrouter'))
			providerConfigs[p.id] = { class: OpenRouterAI, args: [key, url] };
		else if (p.id.includes('deepseek'))
			providerConfigs[p.id] = { class: DeepseekAI, args: [key, url] };
		else if (p.id.includes('imagen'))
			providerConfigs[p.id] = { class: GeminiAI, args: [key] };
		else if (p.id.includes('gemini') || p.id === 'google')
			providerConfigs[p.id] = { class: GeminiAI, args: [key] };
		else providerConfigs[p.id] = { class: OpenAI, args: [key, url] };
	});
	console.log('Core handler components initialized.');

	messageHandler = new MessageHandler(
		initialModelThroughputMap,
		modelCapabilitiesMap
	);

	await refreshProviderCountsInModelsFile();
	handlerDataInitialized = true; // Set flag after successful initialization
	console.log('Handler data initialization complete.');
}

// --- Message Handler Class ---
export class MessageHandler {
	private alpha: number = 0.3;
	private initialModelThroughputMap: Map<string, number>;
	private modelCapabilitiesMap: Map<string, ModelCapability[]>;
	private readonly DEFAULT_GENERATION_SPEED = 50;
	private readonly TIME_WINDOW_HOURS = 24;
	private readonly CONSECUTIVE_ERROR_THRESHOLD = 5; // Threshold for disabling
	private readonly DISABLE_PROVIDER_AFTER_MODELS = (() => {
		const raw = process.env.DISABLE_PROVIDER_AFTER_MODELS;
		const parsed = raw !== undefined ? Number(raw) : NaN;
		if (!Number.isFinite(parsed) || parsed < 1) return 2;
		return Math.floor(parsed);
	})();
	private modelCapabilitiesLastUpdated = 0;
	private readonly MODEL_CAPS_REFRESH_MS = Math.max(
		1000,
		Number(process.env.MODEL_CAPS_REFRESH_MS ?? 5000)
	);
	private readonly providerStatsFlushMs = PROVIDER_STATS_FLUSH_MS;
	private readonly providerStatsBatchSize = PROVIDER_STATS_BATCH_SIZE;
	private readonly providerStatsBufferMaxPending =
		PROVIDER_STATS_BUFFER_MAX_PENDING;
	private readonly pendingProviderStatsUpdates = new Map<
		number,
		PendingProviderStatsUpdate[]
	>();
	private readonly providerStatsFlushTimers = new Map<
		number,
		NodeJS.Timeout
	>();
	private readonly providerStatsFlushes = new Map<number, Promise<void>>();

	private normalizeModelId(modelId: string): string {
		return String(modelId || '')
			.toLowerCase()
			.replace(/^google\//, '');
	}

	private async resolveModelIdForRequest(modelId: string): Promise<string> {
		const raw = String(modelId || '').trim();
		if (!raw) return raw;
		if (this.modelCapabilitiesMap.size === 0) return raw;

		const candidates = new Set<string>();
		const addCandidate = (value: string) => {
			if (value) candidates.add(value);
		};

		addCandidate(raw);
		const lower = raw.toLowerCase();
		addCandidate(lower);

		const slashIndex = raw.lastIndexOf('/');
		if (slashIndex > 0 && slashIndex + 1 < raw.length) {
			addCandidate(raw.slice(slashIndex + 1));
		}

		const lowerSlashIndex = lower.lastIndexOf('/');
		if (lowerSlashIndex > 0 && lowerSlashIndex + 1 < lower.length) {
			addCandidate(lower.slice(lowerSlashIndex + 1));
		}

		for (const candidate of candidates) {
			if (this.modelCapabilitiesMap.has(candidate)) {
				if (candidate !== raw) {
					console.log(
						`[ModelNormalize] Resolved requested model '${raw}' -> '${candidate}'.`
					);
				}
				return candidate;
			}
		}

		try {
			const providers =
				await dataManager.load<LoadedProviders>('providers');
			for (const candidate of candidates) {
				const supported = providers.some(
					(provider: LoadedProviderData) =>
						provider.models && candidate in provider.models
				);
				if (!supported) continue;
				if (candidate !== raw) {
					console.warn(
						`[ModelNormalize] Capability map miss for '${raw}', but live providers support '${candidate}'. Using provider-backed fallback.`
					);
				} else {
					console.warn(
						`[ModelNormalize] Capability map miss for '${raw}', but live providers still advertise it. Using raw model id.`
					);
				}
				return candidate;
			}
		} catch (error: any) {
			console.warn(
				`[ModelNormalize] Failed live provider fallback lookup for '${raw}': ${error?.message || error}`
			);
		}

		const err = new Error(
			`Model not found: ${raw}. No provider (active or disabled) supports model ${raw}.`
		);
		(err as any).code = 'model_not_found';
		throw err;
	}

	private normalizeHandleMessagesArgs(
		requestIdOrOptions?: string | HandleMessagesOptions,
		options?: HandleMessagesOptions
	): { requestId?: string; options: HandleMessagesOptions } {
		if (
			typeof requestIdOrOptions === 'string' ||
			typeof requestIdOrOptions === 'undefined'
		) {
			return {
				requestId: requestIdOrOptions,
				options: options ?? {}
			};
		}

		return {
			requestId: requestIdOrOptions.requestId,
			options: requestIdOrOptions
		};
	}

	private extractMessageOverrides(
		options?: Partial<IMessage> & {
			requestId?: string;
			skipQueue?: boolean;
			queueLane?: RequestQueueLane;
			rateLimitWaitBudgetMs?: number;
			allowStaleCooldownProbe?: boolean;
			disablePassthrough?: boolean;
		}
	): Partial<IMessage> {
		if (!options) return {};
		const {
			requestId: _requestId,
			skipQueue: _skipQueue,
			queueLane: _queueLane,
			rateLimitWaitBudgetMs: _rateLimitWaitBudgetMs,
			allowStaleCooldownProbe: _allowStaleCooldownProbe,
			disablePassthrough: _disablePassthrough,
			...messageOverrides
		} = options;
		return messageOverrides;
	}

	private isGeminiFamilyProvider(providerId: string): boolean {
		return (
			providerId.includes('gemini') ||
			providerId === 'google' ||
			providerId.includes('imagen')
		);
	}

	private getGeminiInputTokenLimit(modelId: string): number {
		const reportedLimit =
			GeminiAI.getModelTokenLimits(modelId)?.inputTokenLimit;
		if (
			typeof reportedLimit === 'number' &&
			Number.isFinite(reportedLimit) &&
			reportedLimit > 0
		) {
			return reportedLimit;
		}
		return GEMINI_INPUT_TOKEN_LIMIT;
	}

	private buildInputTokenLimitError(
		inputTokenEstimate: number,
		breakdown: TokenBreakdown,
		tokenLimit: number
	): Error {
		const hasImageInput = breakdown.imageTokens > 0;
		const hasAudioInput = breakdown.audioTokens > 0;
		const baseMessage = `Input token count exceeds the maximum number of tokens allowed ${tokenLimit}. Estimated input tokens: ${inputTokenEstimate}.`;
		const hint = hasImageInput
			? ' Image input appears too large; reduce image size or use a smaller image.'
			: hasAudioInput
				? ' Audio input appears too large; reduce audio size or duration.'
				: '';
		const err = new Error(`${baseMessage}${hint}`);
		(err as any).code = 'INPUT_TOKENS_EXCEEDED';
		(err as any).inputTokenEstimate = inputTokenEstimate;
		(err as any).inputTokenLimit = tokenLimit;
		(err as any).imageTokenEstimate = breakdown.imageTokens;
		(err as any).audioTokenEstimate = breakdown.audioTokens;
		(err as any).hasImageInput = hasImageInput;
		(err as any).hasAudioInput = hasAudioInput;
		(err as any).status = 400;
		(err as any).retryable = false;
		(err as any).requestRetryWorthless = true;
		return err;
	}

	private shouldUseImagenProvider(
		providerId: string,
		modelId: string
	): boolean {
		const normalizedModelId = this.normalizeModelId(modelId);
		const isGoogleFamilyProvider = this.isGeminiFamilyProvider(providerId);
		const isImagenFamilyModel =
			normalizedModelId.startsWith('imagen-') ||
			normalizedModelId.startsWith('nano-banana');
		return isGoogleFamilyProvider && isImagenFamilyModel;
	}

	private isInvalidProviderCredentialError(error: any): boolean {
		return isInvalidProviderCredentialErrorShared(error);
	}

	private isModelAccessError(error: any): boolean {
		return isModelAccessErrorShared(error);
	}

	private isGeminiRetiredModelError(error: any): boolean {
		const message = String(error?.message || error || '').toLowerCase();
		return (
			message.includes('no longer available to new users') ||
			message.includes('update your code to use a newer model')
		);
	}

	private isGeminiModelId(modelId: string): boolean {
		return this.normalizeModelId(modelId).startsWith('gemini-');
	}

	private async clearGeminiModelNegativeCache(modelId: string): Promise<void> {
		if (!this.isGeminiModelId(modelId)) return;
		await clearModelNegativeCacheEntry('gemini', modelId);
	}

	private async getGeminiModelNegativeCacheError(
		modelId: string
	): Promise<Error | null> {
		if (!this.isGeminiModelId(modelId)) return null;
		const entry = await getModelNegativeCacheEntry('gemini', modelId);
		if (!entry) return null;
		if (entry.reason === 'rate_limit') {
			await clearModelNegativeCacheEntry('gemini', modelId);
			return null;
		}
		console.warn(
			`[GeminiModelNegativeCache] Short-circuiting ${entry.modelId} with cached ${entry.reason} state.`
		);
		const error = new Error(entry.message);
		(error as any).status = entry.statusCode;
		(error as any).statusCode = entry.statusCode;
		(error as any).code = entry.code;
		(error as any).modelId = entry.modelId;
		if (entry.statusCode === 429) {
			const retryAfterMs = Math.max(
				1,
				Math.ceil(entry.retryAfterMs ?? GEMINI_MODEL_NEGATIVE_CACHE_RATE_LIMIT_FLOOR_MS)
			);
			(error as any).retryAfterMs = retryAfterMs;
			(error as any).retryAfterSeconds = Math.max(
				1,
				Math.ceil(retryAfterMs / 1000)
			);
			(error as any).allSkippedByRateLimit = true;
		}
		return error;
	}

	private async cacheGeminiModelNegativeOutcome(
		modelId: string,
		lastError: any,
		nextCooldownMs: number | null
	): Promise<void> {
		if (!this.isGeminiModelId(modelId)) return;
		const normalizedModelId = this.normalizeModelId(modelId);
		if (
			lastError &&
			this.isModelAccessError(lastError) &&
			this.isGeminiRetiredModelError(lastError)
		) {
			await setModelNegativeCacheEntry(
				{
					family: 'gemini',
					modelId: normalizedModelId,
					reason: 'model_not_found',
					statusCode: 404,
					code: 'model_not_found',
					message: `Gemini model ${normalizedModelId} is no longer available to new users.`
				},
				GEMINI_MODEL_NEGATIVE_CACHE_NOT_FOUND_MS
			);
			return;
		}
	}

	private isInsufficientCreditsError(error: any): boolean {
		return isInsufficientCreditsErrorShared(error);
	}

	private isRateLimitOrQuotaError(error: any): boolean {
		return isRateLimitOrQuotaErrorShared(error);
	}

	private isToolUnsupportedError(error: any): boolean {
		return isToolUnsupportedErrorShared(error);
	}

	private isProviderRequestShapeError(error: any): boolean {
		return isProviderRequestShapeErrorShared(error);
	}

	private getProviderFamilyId(providerId: string): string {
		const normalized = String(providerId || '').toLowerCase();
		const dashIndex = normalized.indexOf('-');
		return dashIndex > 0 ? normalized.slice(0, dashIndex) : normalized;
	}

	private hasRecentInsufficientCreditsFailureSignal(
		provider: LoadedProviderData,
		modelId?: string
	): boolean {
		if (!provider) return false;
		const modelData = modelId
			? ((provider.models?.[modelId] as any) ?? null)
			: null;
		const message = [
			provider.lastError,
			(provider as any).last_error,
			(provider as any).error,
			(provider as any).disabled_reason,
			(provider as any).disabledReason,
			modelData?.lastError,
			modelData?.last_error,
			modelData?.disabled_reason,
		]
			.map((value) => String(value || '').trim())
			.filter(Boolean)
			.join(' ');
		const code = String(
			(provider as any).lastErrorCode ||
				(provider as any).last_error_code ||
				modelData?.lastErrorCode ||
				modelData?.last_error_code ||
				''
		);
		const status = Number(
			(provider as any).lastStatus ||
				(provider as any).last_status ||
				modelData?.lastStatus ||
				modelData?.last_status ||
				0
		);
		if (!this.isInsufficientCreditsError({ message, code, status })) {
			return false;
		}

		const newestFailureAt = Math.max(
			0,
			Number(
				(provider as any).lastErrorAt ||
					(provider as any).last_error_at ||
					0
			),
			Number(modelData?.lastErrorAt || modelData?.last_error_at || 0),
			Number(modelData?.disabled_at || 0)
		);
		if (newestFailureAt > 0) {
			return (
				Date.now() - newestFailureAt <=
				PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
			);
		}

		return Boolean(provider.disabled || modelData?.disabled);
	}

	private hasRecentRateLimitOrTimeoutFailureSignal(
		provider: LoadedProviderData,
		modelId?: string
	): boolean {
		return this.getRecentRateLimitOrTimeoutSignalStrength(provider, modelId) !== null;
	}

	private getRecentRateLimitOrTimeoutSignalStrength(
		provider: LoadedProviderData,
		modelId?: string
	): 'cooldown' | 'transient' | null {
		if (!provider) return null;
		const now = Date.now();
		const fastSkipUntil = providerFastSkips.get(provider.id) ?? 0;
		if (fastSkipUntil > now) {
			return 'transient';
		}
		const providerCooldownUntil = providerCooldowns.get(provider.id) ?? 0;
		if (providerCooldownUntil > now) {
			return 'cooldown';
		}
		const modelData = modelId
			? ((provider.models?.[modelId] as any) ?? null)
			: null;
		const message = [
			provider.lastError,
			(provider as any).last_error,
			(provider as any).error,
			(provider as any).disabled_reason,
			(provider as any).disabledReason,
			modelData?.lastError,
			modelData?.last_error,
			modelData?.disabled_reason,
			modelData?.disabledReason
		]
			.map(value => String(value || '').trim())
			.filter(Boolean)
			.join(' ');
		const code = String(
			(provider as any).lastErrorCode ||
				(provider as any).last_error_code ||
				modelData?.lastErrorCode ||
				modelData?.last_error_code ||
				''
		);
		const status = Number(
			(provider as any).lastStatus ||
				(provider as any).last_status ||
				modelData?.lastStatus ||
				modelData?.last_status ||
				0
		);
		const errorLike = { message, code, status };
		const transientLike =
			isTransientProviderGatewayError(errorLike) ||
			this.isRateLimitOrQuotaError(errorLike);
		if (!transientLike) {
			return null;
		}
		const newestFailureAt = Math.max(
			0,
			Number(
				(provider as any).lastErrorAt ||
					(provider as any).last_error_at ||
					0
			),
			Number(modelData?.lastErrorAt || modelData?.last_error_at || 0),
			Number(modelData?.disabled_at || 0)
		);
		if (newestFailureAt <= 0) {
			return Boolean(provider.disabled || modelData?.disabled)
				? 'transient'
				: null;
		}
		const ageMs = now - newestFailureAt;
		if (ageMs <= PROVIDER_LIVE_AUTONOMOUS_COOLDOWN_SKIP_MS) {
			return 'cooldown';
		}
		if (ageMs <= PROVIDER_LIVE_AUTONOMOUS_TRANSIENT_SKIP_MS) {
			return 'transient';
		}
		return null;
	}

	private preferStableToolCallingProviders(
		providers: LoadedProviderData[],
		modelId: string,
		required: Set<ModelCapability>
	): LoadedProviderData[] {
		const shouldPreferStablePool =
			required.has('tool_calling') ||
			providers.some(
				(provider: LoadedProviderData) =>
					this.hasRecentRateLimitOrTimeoutFailureSignal(
						provider,
						modelId
					) ||
					this.hasRecentInsufficientCreditsFailureSignal(
						provider,
						modelId
					)
			);
		if (!shouldPreferStablePool) return providers;
		const stableProviders = providers.filter(
			(provider: LoadedProviderData) =>
				!this.hasRecentRateLimitOrTimeoutFailureSignal(
					provider,
					modelId
				) &&
				!this.hasRecentInsufficientCreditsFailureSignal(
					provider,
					modelId
				)
		);
		if (stableProviders.length === 0) return providers;
		const targetCount = Math.max(
			PROVIDER_MIN_ACTIVE_MODEL_CANDIDATES,
			PROVIDER_QUOTA_REENABLE_CANDIDATE_LIMIT
		);
		if (
			stableProviders.length >= providers.length ||
			stableProviders.length >= targetCount
		) {
			return stableProviders;
		}

		const stableProviderIds = new Set(
			stableProviders.map(provider => provider.id)
		);
		const fallbackProviders = providers
			.filter(provider => !stableProviderIds.has(provider.id))
			.slice(
				0,
				Math.max(
					0,
					targetCount - stableProviders.length
				)
			);
		if (fallbackProviders.length > 0) {
			console.warn(
				`[ProviderStability] Preserving fallback breadth for ${modelId}: ${stableProviders.length} stable + ${fallbackProviders.length} fallback provider(s).`
			);
		}
		return [...stableProviders, ...fallbackProviders];
	}

	private getEffectiveProviderScore(
		provider: LoadedProviderData
	): number | null {
		if (!provider) return null;
		try {
			const computed = calculateProviderScore(
				provider as unknown as ProviderStateStructure,
				PROVIDER_SELECTION_LATENCY_WEIGHT,
				PROVIDER_SELECTION_ERROR_WEIGHT
			);
			return Number.isFinite(computed)
				? computed
				: (provider.provider_score ?? null);
		} catch (error) {
			console.warn(
				`Failed to compute effective score for provider ${provider.id}:`,
				error
			);
			return provider.provider_score ?? null;
		}
	}

	private preserveProviderBreadth(
		preferredProviders: LoadedProviderData[],
		fallbackPool: LoadedProviderData[],
		modelId: string,
		reason: string,
		targetCount: number = Math.max(
			PROVIDER_MIN_ACTIVE_MODEL_CANDIDATES,
			PROVIDER_HEALTH_FILTER_BREADTH_TARGET
		)
	): LoadedProviderData[] {
		if (
			preferredProviders.length === 0 ||
			preferredProviders.length >= fallbackPool.length ||
			preferredProviders.length >= targetCount
		) {
			return preferredProviders;
		}

		const preferredIds = new Set(
			preferredProviders.map(provider => provider.id)
		);
		const fallbackProviders = fallbackPool
			.filter(provider => !preferredIds.has(provider.id))
			.slice(0, Math.max(0, targetCount - preferredProviders.length));
		if (fallbackProviders.length > 0) {
			console.warn(
				`[ProviderBreadth] Preserving ${modelId} breadth after ${reason}: ${preferredProviders.length} preferred + ${fallbackProviders.length} fallback provider(s).`
			);
		}
		return [...preferredProviders, ...fallbackProviders];
	}

	private shouldPreventProviderAutoDisable(
		providers: LoadedProviderData[],
		providerId: string,
		modelId: string
	): boolean {
		if (PROVIDER_AUTO_DISABLE_MIN_ACTIVE <= 0) return false;

		let remainingActive = 0;
		for (const provider of providers) {
			if (!provider || provider.id === providerId || provider.disabled)
				continue;
			const modelData = provider.models?.[modelId] as any;
			if (!modelData || modelData.disabled) continue;
			remainingActive += 1;
			if (remainingActive >= PROVIDER_AUTO_DISABLE_MIN_ACTIVE) {
				return false;
			}
		}

		return true;
	}

	private providerSkipsRequiredCaps(
		provider: LoadedProviderData,
		modelId: string,
		required: Set<ModelCapability>
	): boolean {
		if (!required || required.size === 0) return false;
		const modelData = provider.models?.[modelId];
		const skips = (modelData as any)?.capability_skips as
			| Partial<Record<ModelCapability, string>>
			| undefined;
		if (!skips) return false;
		for (const cap of required) {
			if (skips[cap]) return true;
		}
		return false;
	}

	private providerSupportsLiveAutonomousTraffic(
		provider: LoadedProviderData
	): boolean {
		if (!provider) return false;
		const normalizedId = String(provider.id || '').trim().toLowerCase();
		if (!normalizedId) return false;
		const explicitLive = (provider as any).live === true;
		const explicitAutonomous =
			(provider as any).autonomous === true ||
			(provider as any).autonomous_enabled === true;
		if (explicitLive || explicitAutonomous) return true;
		return !/(^|[-_])(mock|test|sandbox|fake)([-_]|$)/.test(normalizedId);
	}

	private filterLiveAutonomousProviders(
		providers: LoadedProviderData[]
	): LoadedProviderData[] {
		const liveProviders = providers.filter(provider =>
			this.providerSupportsLiveAutonomousTraffic(provider)
		);
		return liveProviders.length > 0 ? liveProviders : providers;
	}

	private appendRecentFailureFallbackProviders(
		allProviders: LoadedProviders,
		candidateProviders: LoadedProviderData[],
		selectedProvider: LoadedProviderData,
		modelId: string,
		required: Set<ModelCapability>,
		triedProviderIds: Set<string>,
		failureSignal: 'cooldown' | 'transient' | null
	): number {
		if (!failureSignal) return 0;
		const targetUrl = selectedProvider.provider_url;
		const targetFamily = this.getProviderFamilyId(selectedProvider.id);
		let added = 0;

		for (const provider of allProviders) {
			if (!provider?.models?.[modelId]) continue;
			if (provider.id === selectedProvider.id) continue;
			if (triedProviderIds.has(provider.id)) continue;
			if (candidateProviders.some(candidate => candidate.id === provider.id)) {
				continue;
			}
			if (!this.providerSupportsLiveAutonomousTraffic(provider)) continue;
			if (this.providerSkipsRequiredCaps(provider, modelId, required)) continue;
			if (this.hasRecentInsufficientCreditsFailureSignal(provider, modelId)) {
				continue;
			}
			if (this.getRecentRateLimitOrTimeoutSignalStrength(provider, modelId)) {
				continue;
			}
			const sameUrl = Boolean(targetUrl && provider.provider_url === targetUrl);
			const sameFamily =
				this.getProviderFamilyId(provider.id) === targetFamily;
			if (!sameUrl && !sameFamily) continue;
			candidateProviders.push(provider);
			added += 1;
		}

		return added;
	}

	private appendQuotaRecoveryFallbackProviders(
		allProviders: LoadedProviders,
		candidateProviders: LoadedProviderData[],
		selectedProvider: LoadedProviderData,
		modelId: string,
		required: Set<ModelCapability>,
		triedProviderIds: Set<string>
	): number {
		const targetUrl = selectedProvider.provider_url;
		const targetFamily = this.getProviderFamilyId(selectedProvider.id);
		let added = 0;

		for (const provider of allProviders) {
			if (!provider?.models?.[modelId]) continue;
			if (provider.id === selectedProvider.id) continue;
			if (triedProviderIds.has(provider.id)) continue;
			if (candidateProviders.some(candidate => candidate.id === provider.id)) {
				continue;
			}
			if (!this.providerSupportsLiveAutonomousTraffic(provider)) continue;
			if (this.hasRecentInsufficientCreditsFailureSignal(provider, modelId)) {
				continue;
			}
			if (
				this.getRecentRateLimitOrTimeoutSignalStrength(provider, modelId)
			) {
				continue;
			}
			if (this.providerSkipsRequiredCaps(provider, modelId, required)) continue;
			const sameUrl = Boolean(targetUrl && provider.provider_url === targetUrl);
			const sameFamily =
				this.getProviderFamilyId(provider.id) === targetFamily;
			if (!sameUrl && !sameFamily) continue;
			candidateProviders.push(provider);
			added += 1;
			if (added >= PROVIDER_QUOTA_REENABLE_CANDIDATE_LIMIT) break;
		}

		return added;
	}

	private appendDisabledProviderCandidates(
		allProviders: LoadedProviders,
		candidateProviders: LoadedProviderData[],
		modelId: string,
		required: Set<ModelCapability>,
		triedProviderIds: Set<string>,
		options?: {
			limit?: number;
			predicate?: (provider: LoadedProviderData) => boolean;
		}
	): number {
		const limit =
			options?.limit && Number.isFinite(options.limit)
				? Math.max(0, Math.floor(options.limit))
				: Number.POSITIVE_INFINITY;
		if (limit === 0) return 0;
		let added = 0;
		for (const provider of allProviders) {
			if (!provider?.models?.[modelId]) continue;
			if (triedProviderIds.has(provider.id)) continue;
			if (candidateProviders.some(cand => cand.id === provider.id)) {
				continue;
			}
			if (!this.providerSupportsLiveAutonomousTraffic(provider)) continue;
			if (
				options?.predicate &&
				!options.predicate(provider)
			) {
				continue;
			}
			if (this.providerSkipsRequiredCaps(provider, modelId, required)) continue;
			const clone = { ...provider, disabled: false };
			const modelData = clone.models?.[modelId] as any;
			if (modelData) {
				clone.models = {
					...clone.models,
					[modelId]: { ...modelData, disabled: false }
				};
			}
			candidateProviders.push(clone);
			added += 1;
			if (added >= limit) break;
		}
		return added;
	}

	private temporarilyReenableDisabledModelCandidates(
		activeProviders: LoadedProviderData[],
		candidateProviders: LoadedProviderData[],
		modelId: string,
		minimumCount: number
	): LoadedProviderData[] {
		if (candidateProviders.length >= minimumCount)
			return candidateProviders;

		const seenProviderIds = new Set(
			candidateProviders.map(provider => provider.id)
		);
		const reenabledProviders = activeProviders
			.filter(provider => {
				if (!provider || seenProviderIds.has(provider.id)) return false;
				const modelData = provider.models?.[modelId] as any;
				return Boolean(modelData?.disabled);
			})
			.sort((left, right) => {
				const leftModelData = left.models?.[modelId] as any;
				const rightModelData = right.models?.[modelId] as any;
				const leftDisabledAt = Number(leftModelData?.disabled_at || 0);
				const rightDisabledAt = Number(
					rightModelData?.disabled_at || 0
				);
				if (leftDisabledAt !== rightDisabledAt)
					return leftDisabledAt - rightDisabledAt;
				return (
					(this.getEffectiveProviderScore(right) ?? -Infinity) -
					(this.getEffectiveProviderScore(left) ?? -Infinity)
				);
			})
			.slice(0, Math.max(0, minimumCount - candidateProviders.length))
			.map(provider => {
				const modelData = provider.models?.[modelId] as any;
				return {
					...provider,
					models: {
						...provider.models,
						[modelId]: {
							...modelData,
							disabled: false
						}
					}
				};
			});

		if (reenabledProviders.length > 0) {
			console.warn(
				`Temporarily re-enabling ${reenabledProviders.length} cooled-down model candidate(s) for ${modelId} ` +
					`to preserve fallback breadth (target=${minimumCount}).`
			);
		}

		return [...candidateProviders, ...reenabledProviders];
	}

	private appendCreditFallbackProviders(
		allProviders: LoadedProviders,
		candidateProviders: LoadedProviderData[],
		selectedProvider: LoadedProviderData,
		modelId: string,
		required: Set<ModelCapability>,
		triedProviderIds: Set<string>
	): number {
		return this.appendQuotaRecoveryFallbackProviders(
			allProviders,
			candidateProviders,
			selectedProvider,
			modelId,
			required,
			triedProviderIds
		);
	}

	/**
	 * After all active candidate providers have failed, append any disabled
	 * providers that support the requested model so they can be tried as a
	 * last resort before returning an error to the user.
	 */
	private appendDisabledFallbackProviders(
		allProviders: LoadedProviders,
		candidateProviders: LoadedProviderData[],
		modelId: string,
		required: Set<ModelCapability>,
		triedProviderIds: Set<string>
	): number {
		return this.appendDisabledProviderCandidates(
			allProviders,
			candidateProviders,
			modelId,
			required,
			triedProviderIds,
			{
				predicate: provider =>
					!this.hasRecentInsufficientCreditsFailureSignal(provider, modelId) &&
					!this.getRecentRateLimitOrTimeoutSignalStrength(provider, modelId)
			}
		);
	}

	private normalizeUsage(
		usage: ProviderUsage | undefined,
		fallbackInput: number,
		fallbackOutput: number
	) {
		let inputTokens =
			typeof usage?.prompt_tokens === 'number'
				? usage.prompt_tokens
				: fallbackInput;
		let outputTokens =
			typeof usage?.completion_tokens === 'number'
				? usage.completion_tokens
				: fallbackOutput;
		const totalTokens =
			typeof usage?.total_tokens === 'number'
				? usage.total_tokens
				: undefined;

		if (totalTokens !== undefined && !Number.isNaN(totalTokens)) {
			if (
				typeof usage?.prompt_tokens === 'number' &&
				typeof usage?.completion_tokens !== 'number'
			) {
				outputTokens = Math.max(0, totalTokens - inputTokens);
			} else if (
				typeof usage?.completion_tokens === 'number' &&
				typeof usage?.prompt_tokens !== 'number'
			) {
				inputTokens = Math.max(0, totalTokens - outputTokens);
			} else if (
				typeof usage?.prompt_tokens !== 'number' &&
				typeof usage?.completion_tokens !== 'number'
			) {
				outputTokens = Math.max(0, totalTokens - inputTokens);
			}
		}

		return {
			inputTokens: Math.max(0, Math.round(inputTokens)),
			outputTokens: Math.max(0, Math.round(outputTokens))
		};
	}

	constructor(
		throughputMap: Map<string, number>,
		capabilitiesMap: Map<string, ModelCapability[]>
	) {
		this.initialModelThroughputMap = throughputMap;
		this.modelCapabilitiesMap = capabilitiesMap;
	}

	private async refreshModelCapabilities(): Promise<void> {
		const now = Date.now();
		if (
			this.modelCapabilitiesMap.size > 0 &&
			now - this.modelCapabilitiesLastUpdated < this.MODEL_CAPS_REFRESH_MS
		) {
			return;
		}
		const modelsFileData =
			await dataManager.load<ModelsFileStructure>('models');
		const modelData = modelsFileData.data || [];
		const nextMap = new Map<string, ModelCapability[]>();
		modelData.forEach((model: ModelDefinition) => {
			const caps = Array.isArray(model.capabilities)
				? (model.capabilities as ModelCapability[])
				: [];
			if (model.id) nextMap.set(model.id, caps);
		});
		this.modelCapabilitiesMap = nextMap;
		this.modelCapabilitiesLastUpdated = now;
	}

	private ensureProviderConfig(
		providerId: string,
		providerData: LoadedProviderData
	): ProviderConfig | null {
		const existing = providerConfigs[providerId];
		if (existing) return existing;

		const key = providerData.apiKey ?? '';
		const url = providerData.provider_url || '';
		let config: ProviderConfig;

		if (providerId.includes('openai'))
			config = { class: OpenAI, args: [key, url] };
		else if (providerId.includes('openrouter'))
			config = { class: OpenRouterAI, args: [key, url] };
		else if (providerId.includes('deepseek'))
			config = { class: DeepseekAI, args: [key, url] };
		else if (providerId.includes('imagen'))
			config = { class: GeminiAI, args: [key] };
		else if (providerId.includes('gemini') || providerId === 'google')
			config = { class: GeminiAI, args: [key] };
		else config = { class: OpenAI, args: [key, url] };

		providerConfigs[providerId] = config;
		console.warn(
			`Provider config missing for ${providerId}; created on demand.`
		);
		return config;
	}

	private detectRequiredCapabilities(
		messages: IMessage[],
		modelId: string
	): Set<ModelCapability> {
		const required = new Set<ModelCapability>();
		messages.forEach(message => {
			const content = message?.content as any;
			if (Array.isArray(content)) {
				content.forEach((part: any) => {
					if (!part || typeof part !== 'object') return;
					if (
						part.type === 'image_url' ||
						part.type === 'input_image'
					)
						required.add('image_input');
					if (part.type === 'input_audio')
						required.add('audio_input');
					// If the user explicitly asks for image_output, treat as required modality
					if (
						part.type === 'text' &&
						typeof part.text === 'string' &&
						part.text.toLowerCase().includes('[image_output]')
					) {
						required.add('image_output');
					}
				});
			}
			const modalities = Array.isArray(message?.modalities)
				? message.modalities.map(m => String(m).toLowerCase())
				: [];
			if (modalities.includes('image')) required.add('image_output');
			if (modalities.includes('audio')) required.add('audio_output');
			if (message?.audio) required.add('audio_output');
			if (
				(Array.isArray(message?.tools) && message.tools.length > 0) ||
				typeof message?.tool_choice !== 'undefined'
			) {
				required.add('tool_calling');
			}
		});

		// Heuristic: if the requested model name implies image generation, demand image_output
		const lowerModel = (modelId || '').toLowerCase();
		if (
			lowerModel.includes('imagen') ||
			lowerModel.includes('image') ||
			lowerModel.includes('vision')
		) {
			required.add('image_output');
		}
		return required;
	}

	private prepareCandidateProviders(
		allProvidersOriginal: LoadedProviders,
		modelId: string,
		tierLimits: TierData,
		userTierName: string
	): LoadedProviderData[] {
		if (!allProvidersOriginal || allProvidersOriginal.length === 0) {
			throw new Error('No provider data available.');
		}

		let activeProviders = allProvidersOriginal.filter(
			(p: LoadedProviderData) => !p.disabled
		);

		// If all providers are disabled, attempt a soft re-enable for providers that support the requested model.
		if (activeProviders.length === 0) {
			const disabledSupporting = allProvidersOriginal.filter(
				(p: LoadedProviderData) =>
					p.disabled && p.models && modelId in p.models
			);
			const reenableableSupporting = disabledSupporting.filter(
				(p: LoadedProviderData) =>
					!shouldSkipGeminiProviderForMessage(p, null)
			);
			if (reenableableSupporting.length > 0) {
				console.warn(
					`All providers disabled; temporarily re-enabling ${reenableableSupporting.length} provider(s) for model ${modelId}.`
				);
				activeProviders = reenableableSupporting.map(p => ({
					...p,
					disabled: false
				}));
			} else {
				throw new Error(
					'All potentially compatible providers are currently disabled due to errors.'
				);
			}
		}

		activeProviders = this.filterLiveAutonomousProviders(activeProviders);

		try {
			applyTimeWindow(
				activeProviders as ProviderStateStructure[],
				this.TIME_WINDOW_HOURS
			);
		} catch (e) {
			console.error('Error applying time window:', e);
		}

		// Auto-recover disabled models whose recovery window has elapsed (exponential backoff)
		const now = Date.now();
		for (const p of activeProviders) {
			const modelData = p.models?.[modelId] as Model | undefined;
			if (modelData?.disabled && modelData.disabled_at) {
				const disableCount = modelData.disable_count || 1;
				const backoffMs = Math.min(
					PROVIDER_AUTO_RECOVER_MS * Math.pow(2, disableCount - 1),
					PROVIDER_AUTO_RECOVER_MAX_MS
				);
				if (now - modelData.disabled_at >= backoffMs) {
					console.log(
						`Auto-recovering model ${modelId} in provider ${p.id} after ${Math.round(backoffMs / 1000)}s backoff (disable_count=${disableCount}).`
					);
					modelData.disabled = false;
					// Keep disabled_at and disable_count intact — they get cleared on success or incremented on next failure
				}
			}
		}

		let compatibleProviders = activeProviders.filter(
			(p: LoadedProviderData) => {
				const modelData = p.models?.[modelId];
				return Boolean(modelData && !(modelData as any).disabled);
			}
		);
			compatibleProviders = this.filterLiveAutonomousProviders(compatibleProviders);
			const creditHealthyCompatibleProviders = compatibleProviders.filter(
				(p: LoadedProviderData) =>
					!this.hasRecentInsufficientCreditsFailureSignal(p, modelId)
			);
			if (creditHealthyCompatibleProviders.length > 0) {
				compatibleProviders = this.preserveProviderBreadth(
					creditHealthyCompatibleProviders,
					compatibleProviders,
					modelId,
					'credit-health filtering'
				);
			}
			const transientHealthyCompatibleProviders = compatibleProviders.filter(
				(p: LoadedProviderData) =>
					!this.hasRecentRateLimitOrTimeoutFailureSignal(p, modelId)
			);
			if (transientHealthyCompatibleProviders.length > 0) {
				compatibleProviders = this.preserveProviderBreadth(
					transientHealthyCompatibleProviders,
					compatibleProviders,
					modelId,
					'transient-health filtering'
				);
			}
		if (compatibleProviders.length === 0) {
			const activeModelDisabled = activeProviders
				.filter((p: LoadedProviderData) =>
					Boolean((p.models?.[modelId] as any)?.disabled)
				)
				.map((p: LoadedProviderData) => ({
					...p,
					models: {
						...p.models,
						[modelId]: {
							...(p.models?.[modelId] as any),
							disabled: false
						}
					}
				}));
			if (activeModelDisabled.length > 0) {
				console.warn(
					`No currently active providers support model ${modelId}; temporarily re-enabling ${activeModelDisabled.length} cooled-down model candidate(s).`
				);
				compatibleProviders = activeModelDisabled;
			} else {
				const disabledSupporting = allProvidersOriginal.filter(
					(p: LoadedProviderData) =>
						p.disabled && p.models && modelId in p.models
				);
				const reenableableSupporting = disabledSupporting.filter(
					(p: LoadedProviderData) =>
						!shouldSkipGeminiProviderForMessage(p, null)
				);
				if (reenableableSupporting.length > 0) {
					console.warn(
						`Re-enabling ${reenableableSupporting.length} disabled provider(s) for model ${modelId}.`
					);
					compatibleProviders = reenableableSupporting
						.map(p => ({ ...p, disabled: false }))
						.filter((p: LoadedProviderData) => {
							const modelData = p.models?.[modelId];
							return Boolean(
								modelData && !(modelData as any).disabled
							);
						});
				} else {
					const anyProviderHasModel = allProvidersOriginal.some(
						(p: LoadedProviderData) =>
							p.models && modelId in p.models
					);
					if (!anyProviderHasModel) {
						throw new Error(
							`No provider (active or disabled) supports model ${modelId}`
						);
					} else {
						throw new Error(
							`No currently active provider supports model ${modelId}. All supporting providers may be temporarily disabled.`
						);
					}
				}
			}
		}

		compatibleProviders = this.temporarilyReenableDisabledModelCandidates(
			activeProviders,
			compatibleProviders,
			modelId,
			PROVIDER_MIN_ACTIVE_MODEL_CANDIDATES
		);
		compatibleProviders = this.filterLiveAutonomousProviders(compatibleProviders);
		compatibleProviders = this.preferStableToolCallingProviders(
			compatibleProviders,
			modelId,
			new Set<ModelCapability>()
		);

		const selectionScoreCache = new Map<string, number | null>();
		const getSelectionScore = (
			provider: LoadedProviderData
		): number | null => {
			if (selectionScoreCache.has(provider.id)) {
				return selectionScoreCache.get(provider.id) ?? null;
			}
			const score = this.getEffectiveProviderScore(provider);
			selectionScoreCache.set(provider.id, score);
			return score;
		};

		const eligibleProviders = compatibleProviders.filter(
			(p: LoadedProviderData) => {
				const score = getSelectionScore(p);
				const minOk =
					tierLimits.min_provider_score === null ||
					(score !== null && score >= tierLimits.min_provider_score);
				const maxOk =
					tierLimits.max_provider_score === null ||
					(score !== null && score <= tierLimits.max_provider_score);
				return minOk && maxOk;
			}
		);
		const healthyEligibleProviders = eligibleProviders.filter(provider => {
			const score = getSelectionScore(provider);
			return score === null || score >= PROVIDER_SELECTION_DEGRADED_SCORE;
		});
		const primaryEligibleProviders =
			healthyEligibleProviders.length > 0
				? healthyEligibleProviders
				: eligibleProviders;

		let candidateProviders: LoadedProviderData[] = [];
		const randomChoice = Math.random();

		if (primaryEligibleProviders.length > 0) {
			if (userTierName === 'enterprise') {
				primaryEligibleProviders.sort(
					(a, b) =>
						(getSelectionScore(b) ?? -Infinity) -
						(getSelectionScore(a) ?? -Infinity)
				);
			} else if (userTierName === 'pro') {
				primaryEligibleProviders.sort(
					(a, b) =>
						(getSelectionScore(b) ?? -Infinity) -
						(getSelectionScore(a) ?? -Infinity)
				);
				const pickBestProbability = 0.8;
				if (
					randomChoice >= pickBestProbability &&
					primaryEligibleProviders.length > 1
				) {
					const randomIndex =
						Math.floor(
							Math.random() *
								(primaryEligibleProviders.length - 1)
						) + 1;
					[
						primaryEligibleProviders[0],
						primaryEligibleProviders[randomIndex]
					] = [
						primaryEligibleProviders[randomIndex],
						primaryEligibleProviders[0]
					];
				}
			} else {
				primaryEligibleProviders.sort((a, b) =>
					a === b
						? 0
						: (getSelectionScore(a) ?? Infinity) -
							(getSelectionScore(b) ?? Infinity)
				);
				const pickWorstProbability = 0.7;
				if (
					randomChoice >= pickWorstProbability &&
					primaryEligibleProviders.length > 1
				) {
					const randomIndex =
						Math.floor(
							Math.random() *
								(primaryEligibleProviders.length - 1)
						) + 1;
					[
						primaryEligibleProviders[0],
						primaryEligibleProviders[randomIndex]
					] = [
						primaryEligibleProviders[randomIndex],
						primaryEligibleProviders[0]
					];
				}
			}
			candidateProviders = [...primaryEligibleProviders];
		}

		const fallbackProviders = compatibleProviders
			.filter(cp => !candidateProviders.some(cand => cand.id === cp.id))
			.sort(
				(a, b) =>
					(getSelectionScore(b) ?? -Infinity) -
					(getSelectionScore(a) ?? -Infinity)
			);

		candidateProviders = [...candidateProviders, ...fallbackProviders];

		if (candidateProviders.length === 0) {
			throw new Error(
				`Could not determine any candidate providers for model ${modelId}.`
			);
		}

		return candidateProviders;
	}

	private validateModelCapabilities(modelId: string, messages: IMessage[]) {
		const caps = this.modelCapabilitiesMap.get(modelId) || [];
		if (caps.length === 0) return;
		const required = this.detectRequiredCapabilities(messages, modelId);
		const missing = Array.from(required).filter(cap => !caps.includes(cap));
		if (missing.length > 0) {
			throw new Error(
				`Model ${modelId} missing required capabilities: ${missing.join(', ')}`
			);
		}
	}

	private filterProvidersByCapabilitySkips(
		providers: LoadedProviderData[],
		modelId: string,
		required: Set<ModelCapability>
	): LoadedProviderData[] {
		if (!required || required.size === 0) return providers;
		return providers.filter(provider => {
			const modelData = provider.models?.[modelId];
			if (
				(modelData as any)?.disabled ||
				(modelData as any)?.removed ||
				(modelData as any)?.unavailable
			) return false;
			const skips = ((modelData as any)?.capability_skips || {}) as
				Partial<Record<ModelCapability, string>>;
			const blocked = Array.isArray((modelData as any)?.capability_blocked)
				? ((modelData as any).capability_blocked as unknown[])
					.map((cap) => String(cap || '').trim().toLowerCase())
					.filter(Boolean)
				: [];
			const availableCaps = Array.isArray((modelData as any)?.capabilities)
				? ((modelData as any).capabilities as unknown[])
					.map((cap) => String(cap || '').trim().toLowerCase())
					.filter(Boolean)
				: [];
			const normalizedAvailableCaps =
				availableCaps.length > 0 ? new Set(availableCaps) : null;
			for (const cap of required) {
				if (skips[cap]) return false;
				if (blocked.includes(String(cap).toLowerCase())) return false;
				if (
					normalizedAvailableCaps &&
					!normalizedAvailableCaps.has(String(cap).toLowerCase())
				) {
					return false;
				}
			}
			return true;
		});
	}

	private enqueueProviderStatsUpdate(update: PendingProviderStatsUpdate): {
		index: number;
		pending: number;
		dropped: boolean;
	} {
		const index = getProviderStatsQueueIndex(
			update.providerId,
			update.modelId
		);
		const pending = this.pendingProviderStatsUpdates.get(index) || [];
		let dropped = false;
		if (pending.length >= this.providerStatsBufferMaxPending) {
			pending.shift();
			dropped = true;
		}
		pending.push(update);
		this.pendingProviderStatsUpdates.set(index, pending);
		return { index, pending: pending.length, dropped };
	}

	private scheduleProviderStatsFlush(index: number, immediate = false): void {
		if (this.providerStatsFlushTimers.has(index)) return;
		const delay = immediate ? 0 : this.providerStatsFlushMs;
		const timer = setTimeout(() => {
			this.providerStatsFlushTimers.delete(index);
			void this.flushProviderStatsUpdates(index);
		}, delay);
		this.providerStatsFlushTimers.set(index, timer);
	}

	private async recomputeProviderMetricsInProviderList(
		providers: LoadedProviderData[],
		providerId: string
	): Promise<LoadedProviderData[]> {
		const providerIndex = providers.findIndex(p => p.id === providerId);
		if (providerIndex === -1) return providers;
		const providerData = providers[providerIndex];
		providers[providerIndex] = await computeProviderMetricsInWorker(
			providerData as ProviderStateStructure,
			this.alpha,
			0.7,
			0.3
		);
		return providers;
	}

	private async flushProviderStatsUpdates(index: number): Promise<void> {
		const activeFlush = this.providerStatsFlushes.get(index);
		if (activeFlush) {
			await activeFlush;
			return;
		}

		const pending = this.pendingProviderStatsUpdates.get(index);
		if (!pending || pending.length === 0) return;

		const batch = pending.splice(0, this.providerStatsBatchSize);
		if (pending.length === 0) {
			this.pendingProviderStatsUpdates.delete(index);
		}

		const flushPromise = (async () => {
			const queue = getProviderStatsQueueByIndex(index);
			let rescheduleImmediate = true;
			try {
				await queue.run(async () => {
					await dataManager.updateWithLock<LoadedProviders>(
						'providers',
						async currentProvidersData => {
							let nextProviders = currentProvidersData;
							const touchedProviderIds = new Set<string>();

							for (const update of batch) {
								touchedProviderIds.add(update.providerId);
								nextProviders =
									await this.updateStatsInProviderList(
										nextProviders,
										update.providerId,
										update.modelId,
										update.responseEntry,
										update.isError,
										update.attemptError,
										true
									);
							}

							for (const providerId of touchedProviderIds) {
								nextProviders =
									await this.recomputeProviderMetricsInProviderList(
										nextProviders,
										providerId
									);
							}

							return nextProviders;
						}
					);
				});
			} catch (statsError: any) {
				if (
					statsError?.code === 'QUEUE_OVERLOADED' ||
					statsError?.statusCode === 503
				) {
					const rest =
						this.pendingProviderStatsUpdates.get(index) || [];
					this.pendingProviderStatsUpdates.set(index, [
						...batch,
						...rest
					]);
					rescheduleImmediate = false;
					console.warn(
						`[ProviderStats] Delaying ${batch.length} buffered stats update(s) on worker ${index + 1}/${providerStatsQueues.length}: ` +
							`provider stats queue overloaded (pending=${queue.pending}, inFlight=${queue.inFlight}).`
					);
					return;
				}
				console.error(
					`[ProviderStats] Error flushing buffered stats updates on worker ${index + 1}/${providerStatsQueues.length}. Error:`,
					statsError
				);
			} finally {
				this.providerStatsFlushes.delete(index);
				if (
					(this.pendingProviderStatsUpdates.get(index)?.length || 0) >
					0
				) {
					this.scheduleProviderStatsFlush(index, rescheduleImmediate);
				}
			}
		})();

		this.providerStatsFlushes.set(index, flushPromise);
		await flushPromise;
	}

	private async updateStatsInProviderList(
		providers: LoadedProviderData[],
		providerId: string,
		modelId: string,
		responseEntry: ResponseEntry | null,
		isError: boolean,
		attemptError?: any,
		skipMetrics = false
	): Promise<LoadedProviderData[]> {
		const providerIndex = providers.findIndex(p => p.id === providerId);
		if (providerIndex === -1) return providers;
		let providerData = providers[providerIndex];
		if (!providerData.models[modelId]) {
			// Initialize model data including consecutive_errors
			providerData.models[modelId] = {
				id: modelId,
				token_generation_speed:
					this.initialModelThroughputMap.get(modelId) ??
					this.DEFAULT_GENERATION_SPEED,
				response_times: [],
				errors: 0,
				consecutive_errors: 0, // Initialize consecutive errors
				avg_response_time: null,
				avg_provider_latency: null,
				avg_token_speed:
					this.initialModelThroughputMap.get(modelId) ??
					this.DEFAULT_GENERATION_SPEED,
				rate_limit_rps: null,
				rate_limit_requests: null,
				rate_limit_window_ms: null,
				disabled: false
			};
		}

		// Ensure model data object exists and initialize consecutive_errors if missing for older data
		const modelData = providerData.models[modelId];
		if (modelData.consecutive_errors === undefined) {
			modelData.consecutive_errors = 0;
		}
		if (modelData.disabled === undefined) {
			modelData.disabled = false;
		}

		// Ensure provider data object exists and initialize disabled if missing for older data
		if (providerData.disabled === undefined) {
			providerData.disabled = false;
		}

		// Update consecutive errors and disabled status
		if (isError) {
			const errorMessage = summarizeProviderStateErrorMessage(
				attemptError
			);
			const errorCode = getProviderStateErrorCode(attemptError);
			const errorStatus = getProviderStateErrorStatus(attemptError);
			if (errorMessage) {
				(providerData as any).lastError = errorMessage;
			} else {
				delete (providerData as any).lastError;
			}
			if (errorCode) {
				(providerData as any).lastErrorCode = errorCode;
			} else {
				delete (providerData as any).lastErrorCode;
			}
			if (errorStatus !== null) {
				(providerData as any).lastStatus = errorStatus;
			} else {
				delete (providerData as any).lastStatus;
			}
			(providerData as any).lastErrorAt = Date.now();

			if (this.isRateLimitOrQuotaError(attemptError)) {
				const rateLimitMessage = String(
					attemptError?.message || attemptError || ''
				);
				const rateLimitRps = extractRateLimitRps(rateLimitMessage);
				const rateLimitWindow =
					extractRateLimitWindow(rateLimitMessage);
				const retryAfterMs = extractRetryAfterMs(rateLimitMessage);
				if (rateLimitWindow !== null) {
					modelData.rate_limit_requests = smoothPositiveInteger(
						modelData.rate_limit_requests,
						rateLimitWindow.requests
					);
					modelData.rate_limit_window_ms = smoothPositiveInteger(
						modelData.rate_limit_window_ms,
						rateLimitWindow.windowMs
					);
				} else if (retryAfterMs && retryAfterMs > 0) {
					const estimatedRequests =
						estimateRateLimitRequestsFromBurst(
							providerId,
							modelId,
							retryAfterMs
						);
					if (estimatedRequests !== null) {
						modelData.rate_limit_requests = smoothPositiveInteger(
							modelData.rate_limit_requests,
							estimatedRequests
						);
						modelData.rate_limit_window_ms = smoothPositiveInteger(
							modelData.rate_limit_window_ms,
							retryAfterMs
						);
					}
				}
				if (rateLimitRps !== null) {
					modelData.rate_limit_rps = rateLimitRps;
				} else if (
					rateLimitWindow !== null &&
					rateLimitWindow.windowMs > 0
				) {
					modelData.rate_limit_rps =
						rateLimitWindow.requests /
						Math.max(0.001, rateLimitWindow.windowMs / 1000);
				} else {
					if (retryAfterMs && retryAfterMs > 0) {
						modelData.rate_limit_rps = 1 / (retryAfterMs / 1000);
					} else if (modelData.rate_limit_rps === undefined) {
						modelData.rate_limit_rps = null;
					}
				}
			}
				// Remove model from provider if error indicates permanent access denial
				if (this.isModelAccessError(attemptError)) {
					console.warn(
						`Removing model ${modelId} from provider ${providerId} due to permanent access restriction (Error: ${attemptError?.message || 'unknown'}).`
					);
					delete providerData.models[modelId];
					if (
						this.isGeminiFamilyProvider(providerId) &&
						this.isGeminiRetiredModelError(attemptError)
					) {
						const sourceUrl = String(providerData.provider_url || '');
						let removedSiblingCount = 0;
						for (const siblingProvider of providers) {
							if (!siblingProvider || siblingProvider.id === providerId) {
								continue;
							}
							if (!this.isGeminiFamilyProvider(siblingProvider.id)) {
								continue;
							}
							if (
								sourceUrl &&
								String(siblingProvider.provider_url || '') !== sourceUrl
							) {
								continue;
							}
							if (!siblingProvider.models?.[modelId]) {
								continue;
							}
							delete siblingProvider.models[modelId];
							removedSiblingCount += 1;
						}
						if (removedSiblingCount > 0) {
							console.warn(
								`Removing model ${modelId} from ${removedSiblingCount} sibling Gemini provider(s) after upstream retired-model response.`
							);
						}
					}
					// Return immediately without incrementing errors or disabling provider
					return providers;
				}

			if (AUTO_DISABLE_PROVIDERS && isZeroQuotaError(attemptError)) {
				if (!providerData.disabled) {
					console.warn(
						`Disabling provider ${providerId} due to zero quota.`
					);
				}
				providerData.disabled = true;
				(providerData as any).disabled_reason =
					errorMessage || 'zero quota';
				modelData.disabled = true;
				modelData.consecutive_errors = this.CONSECUTIVE_ERROR_THRESHOLD;
				modelData.disabled_at = Date.now();
				modelData.disable_count = (modelData.disable_count || 0) + 1;
			} else if (this.isRateLimitOrQuotaError(attemptError)) {
				// Cooldown and distributed throttling already handle transient capacity failures.
				// Avoid converting 429/quota bursts into model auto-disables that collapse the
				// candidate pool for subsequent requests.
				// Skip error counting entirely for excluded error patterns
			} else if (
				isExcludedError(attemptError) ||
				this.isToolUnsupportedError(attemptError) ||
				this.isProviderRequestShapeError(attemptError)
			) {
				// Don't increment errors or disable — treat as a non-event
			} else if (
				AUTO_DISABLE_PROVIDERS &&
				this.isInvalidProviderCredentialError(attemptError)
			) {
				if (!providerData.disabled) {
					console.warn(
						`Disabling provider ${providerId} due to invalid provider credentials.`
					);
				}
				providerData.disabled = true;
				(providerData as any).disabled_reason =
					errorMessage || 'invalid provider credentials';
				modelData.consecutive_errors = this.CONSECUTIVE_ERROR_THRESHOLD;
				modelData.disabled_at = Date.now();
				modelData.disable_count = (modelData.disable_count || 0) + 1;
			} else {
				modelData.consecutive_errors =
					(modelData.consecutive_errors || 0) + 1;
				if (
					modelData.consecutive_errors >=
					this.CONSECUTIVE_ERROR_THRESHOLD
				) {
					if (!modelData.disabled) {
						console.warn(
							`Disabling model ${modelId} in provider ${providerId} after ${modelData.consecutive_errors} consecutive errors.`
						);
						modelData.disabled_at = Date.now();
						modelData.disable_count =
							(modelData.disable_count || 0) + 1;
					}
					modelData.disabled = true;

					if (AUTO_DISABLE_PROVIDERS) {
						const disabledModels = Object.values(
							providerData.models || {}
						).filter((m: any) => m?.disabled).length;
						if (
							disabledModels >=
								this.DISABLE_PROVIDER_AFTER_MODELS &&
							!providerData.disabled
						) {
							if (
								this.shouldPreventProviderAutoDisable(
									providers,
									providerId,
									modelId
								)
							) {
								console.warn(
									`Skipping provider auto-disable for ${providerId} after ${disabledModels} disabled models because it would leave fewer than ${PROVIDER_AUTO_DISABLE_MIN_ACTIVE} active provider(s) for model ${modelId}.`
								);
							} else {
								console.warn(
									`Disabling provider ${providerId} after ${disabledModels} models were disabled due to consecutive errors.`
								);
								providerData.disabled = true;
								(providerData as any).disabled_reason =
									errorMessage ||
									'consecutive provider model failures';
							}
						}
					}
				}
			}
		} else {
			// Reset consecutive errors on success for this specific model
			modelData.consecutive_errors = 0;
			delete (providerData as any).lastError;
			delete (providerData as any).lastErrorCode;
			delete (providerData as any).lastStatus;
			delete (providerData as any).lastErrorAt;
			delete (providerData as any).disabled_reason;
			if (modelData.disabled) {
				console.log(
					`Re-enabling model ${modelId} in provider ${providerId} after successful request.`
				);
				modelData.disabled = false;
				modelData.disabled_at = undefined;
				modelData.disable_count = 0;
			}
			if (providerData.disabled) {
				const remainingDisabled = Object.values(
					providerData.models || {}
				).filter((m: any) => m?.disabled).length;
				console.log(
					remainingDisabled === 0
						? `Re-enabling provider ${providerId} — all models are healthy after success on ${modelId}.`
						: `Re-enabling provider ${providerId} after success on ${modelId}; ${remainingDisabled} model(s) remain disabled.`
				);
				providerData.disabled = false;
			}
		}

		updateProviderData(
			providerData as ProviderStateStructure,
			modelId,
			responseEntry,
			isError
		);
		if (!skipMetrics) {
			providerData = await computeProviderMetricsInWorker(
				providerData as ProviderStateStructure,
				this.alpha,
				0.7,
				0.3
			);
		}
		providers[providerIndex] = providerData;
		return providers;
	}

	// Temporary model reroute map — requests for key are redirected to value
	// To add a reroute: MODEL_REROUTES['source-model'] = 'target-model';
	private static readonly MODEL_REROUTES: Record<string, string> = {
		'gemini-2.0-flash': 'gemini-2.5-flash',
		'gemini-2.0-flash-001': 'gemini-2.5-flash',
		'google/gemini-2.0-flash': 'gemini-2.5-flash',
		'google/gemini-2.0-flash-001': 'gemini-2.5-flash'
	};

	private applyModelReroute(modelId: string): string {
		const target = MessageHandler.MODEL_REROUTES[modelId];
		if (target) {
			console.log(`[ModelReroute] Redirecting ${modelId} → ${target}`);
			return target;
		}
		return modelId;
	}

	private relaxUnsupportedToolCalling(
		modelId: string,
		messages: IMessage[]
	): IMessage[] {
		const normalized = this.normalizeModelId(modelId);
		if (!normalized.startsWith('gemini-')) return messages;

		const capabilities = this.modelCapabilitiesMap.get(normalized) || [];
		if (capabilities.includes('tool_calling')) return messages;

		let stripped = false;
		const relaxedMessages = messages.map((message: IMessage) => {
			const hasTools =
				Array.isArray(message?.tools) && message.tools.length > 0;
			const hasToolChoice =
				typeof message?.tool_choice !== 'undefined';
			if (!hasTools && !hasToolChoice) return message;

			stripped = true;
			const nextMessage: IMessage = { ...message };
			delete (nextMessage as any).tools;
			delete (nextMessage as any).tool_choice;
			return nextMessage;
		});

		if (stripped) {
			console.warn(
				`[CapabilityRelax] ${normalized} does not support tool_calling; dropping tools/tool_choice for this request.`
			);
		}

		return stripped ? relaxedMessages : messages;
	}

	async handleMessages(
		messages: IMessage[],
		modelId: string,
		apiKey: string,
		requestIdOrOptions?: string | HandleMessagesOptions,
		legacyOptions?: HandleMessagesOptions
	): Promise<any> {
		const normalizedArgs = this.normalizeHandleMessagesArgs(
			requestIdOrOptions,
			legacyOptions
		);
		const requestId = normalizedArgs.requestId;
		const options = normalizedArgs.options;
		const rateLimitWaitBudgetMs =
			typeof options?.rateLimitWaitBudgetMs === 'number' &&
			Number.isFinite(options.rateLimitWaitBudgetMs)
				? Math.max(0, Math.floor(options.rateLimitWaitBudgetMs))
				: RATE_LIMIT_TOTAL_WAIT_BUDGET_MS;
		const allowStaleCooldownProbe =
			options?.allowStaleCooldownProbe === true;
		const messageOverrides = this.extractMessageOverrides(options);
		const shouldUseRequestQueue = !options?.skipQueue;
		const requestQueue = getRequestQueueForLane(options?.queueLane);
		const execute = async () => {
			if (!messages?.length || !modelId || !apiKey)
				throw new Error('Invalid arguments');
			if (!messageHandler)
				throw new Error('Service temporarily unavailable.');
				modelId = this.applyModelReroute(modelId);

				await this.refreshModelCapabilities();
				modelId = await this.resolveModelIdForRequest(modelId);
				const cachedGeminiModelError =
					await this.getGeminiModelNegativeCacheError(modelId);
				if (cachedGeminiModelError) throw cachedGeminiModelError;
				messages = this.relaxUnsupportedToolCalling(modelId, messages);
				const requiredCaps = this.detectRequiredCapabilities(
					messages,
					modelId
				);
				this.validateModelCapabilities(modelId, messages);

				const validationResult = await validateApiKeyAndUsage(apiKey);
			if (
				!validationResult.valid ||
				!validationResult.userData ||
				!validationResult.tierLimits
			) {
				const statusCode = validationResult.error?.includes(
					'limit reached'
				)
					? 429
					: 401;
				throw new Error(
					`${statusCode === 429 ? 'Limit reached' : 'Unauthorized'}: ${validationResult.error}`
				);
			}
				const userData: UserData = validationResult.userData;
				const tierLimits: TierData = validationResult.tierLimits;
				const userTierName = userData.tier;
				assertModelAllowedForTier(modelId, tierLimits);
				const allProvidersOriginal =
					await dataManager.load<LoadedProviders>('providers');
				let candidateProviders: LoadedProviderData[];
				try {
					candidateProviders = this.prepareCandidateProviders(
						allProvidersOriginal,
						modelId,
						tierLimits,
						userTierName
					);
				} catch (error: any) {
					if (
						this.isGeminiModelId(modelId) &&
						/no currently active provider supports model/i.test(
							String(error?.message || '')
						)
					) {
						await this.cacheGeminiModelNegativeOutcome(
							modelId,
							null,
							GEMINI_MODEL_NEGATIVE_CACHE_RATE_LIMIT_FLOOR_MS
						);
						const cachedGeminiModelError =
							await this.getGeminiModelNegativeCacheError(modelId);
						if (cachedGeminiModelError) throw cachedGeminiModelError;
					}
					throw error;
				}
				candidateProviders = this.filterProvidersByCapabilitySkips(
					candidateProviders,
					modelId,
				requiredCaps
			);
			candidateProviders = this.preferStableToolCallingProviders(
				candidateProviders,
				modelId,
				requiredCaps
			);
			const filteredGeminiProviders = candidateProviders.filter(
				(provider: LoadedProviderData) =>
					!shouldSkipGeminiProviderForMessage(provider, messages)
			);
			if (filteredGeminiProviders.length > 0) {
				candidateProviders = filteredGeminiProviders;
			}
			if (candidateProviders.length === 0) {
				throw new Error(
					`No providers available for model ${modelId} after capability filtering.`
				);
			}

			const inputTokenBreakdown =
				estimateTokensFromMessagesBreakdown(messages);
			const inputTokenEstimate = inputTokenBreakdown.total;
			const geminiInputTokenLimit =
				this.getGeminiInputTokenLimit(modelId);
			if (
				inputTokenEstimate > geminiInputTokenLimit &&
				candidateProviders.every(p => this.isGeminiFamilyProvider(p.id))
			) {
				throw this.buildInputTokenLimitError(
					inputTokenEstimate,
					inputTokenBreakdown,
					geminiInputTokenLimit
				);
			}

			// --- Attempt Loop ---
			let lastError: any = null;
			const triedProviderIds = new Set<string>();
			const blockedApiKeys = new Set<string>();
			const shouldRespectCooldowns = !RATE_LIMIT_SKIP_WAIT;
			const shouldReuseProviderOrder =
				shouldRespectCooldowns && RATE_LIMIT_WAIT_PER_MESSAGE;
			let skippedByCooldown = 0;
			let skippedByBlockedKey = 0;
			let skippedByProviderRateLimit = 0;
			let disabledFallbackAdded = false;
			const requestStartTime = Date.now();
			const totalCandidates = candidateProviders.length;
			let effectiveRateLimitWaitBudgetMs = rateLimitWaitBudgetMs;
			let cooldownWaitSpentMs = 0;
				let nextCooldownMs: number | null = null;
				let nextCooldownEarlyWakeMs: number | null = null;
				let attemptedSinceCooldown = false;
				let geminiRateLimitFailureCount = 0;
				let staleCooldownProbeUsed = false;
			const tryStaleCooldownProbe = (
				providerId: string,
				modelId: string,
				reason: string
			): boolean => {
				if (!allowStaleCooldownProbe || staleCooldownProbeUsed) {
					return false;
				}
				staleCooldownProbeUsed = true;
				console.warn(
					`[CooldownProbe] Ignoring ${reason} once for internal request on ${providerId}/${modelId}.`
				);
				return true;
			};
			for (;;) {
				let releaseQueueSlot: (() => void) | null = null;
				try {
					if (shouldUseRequestQueue) {
						releaseQueueSlot = await requestQueue.acquire();
					}
					for (let idx = 0; idx < candidateProviders.length; idx++) {
						// Check request-level deadline before each attempt
						const elapsed = Date.now() - requestStartTime;
						if (
							REQUEST_DEADLINE_MS > 0 &&
							elapsed >= REQUEST_DEADLINE_MS
						) {
							console.warn(
								`Request deadline (${REQUEST_DEADLINE_MS}ms) exceeded after ${elapsed}ms and ${triedProviderIds.size} provider(s) for model ${modelId}. Aborting.`
							);
							if (!lastError)
								lastError = new Error(
									`Request deadline exceeded (${REQUEST_DEADLINE_MS}ms)`
								);
							idx = candidateProviders.length;
							break;
						}

							const selectedProvider = candidateProviders[idx];
							const providerId = selectedProvider.id;
							const providerApiKey = selectedProvider.apiKey ?? '';
							const modelStats = selectedProvider?.models?.[modelId];
							const fastSkipRemainingMs =
								getProviderFastSkipRemainingMs(providerId);
							if (fastSkipRemainingMs !== null) {
								if (
									tryStaleCooldownProbe(
										providerId,
										modelId,
										'provider fast-skip'
									)
								) {
									// Probe one candidate despite fast-skip state.
								} else {
									skippedByCooldown++;
									if (
										nextCooldownMs === null ||
										fastSkipRemainingMs < nextCooldownMs
									) {
										nextCooldownMs = fastSkipRemainingMs;
										nextCooldownEarlyWakeMs = null;
									}
									continue;
								}
							}
						if (
							providerApiKey &&
							(await isApiKeyCoolingDownForModel(
								providerApiKey,
								modelId
							))
						) {
							if (
								tryStaleCooldownProbe(
									providerId,
									modelId,
									'api-key cooldown'
								)
							) {
								// Probe one candidate despite stale cooldown state.
							} else {
							skippedByCooldown++;
							if (shouldRespectCooldowns) {
								const remainingMs =
									await getApiKeyCooldownMsForModel(
										providerApiKey,
										modelId
									);
								if (remainingMs !== null) {
									nextCooldownMs =
										nextCooldownMs === null
											? remainingMs
											: Math.min(
													nextCooldownMs,
													remainingMs
												);
									if (nextCooldownMs === remainingMs) {
										nextCooldownEarlyWakeMs = null;
									}
								}
							}
							continue;
							}
						}
						const distributedCooldownMs =
							await getDistributedProviderCooldownMs(
								providerId,
								modelId
							);
						if (
							distributedCooldownMs !== null &&
							distributedCooldownMs > 0
						) {
							if (
								tryStaleCooldownProbe(
									providerId,
									modelId,
									'distributed provider cooldown'
								)
							) {
								// Probe one candidate despite stale distributed cooldown state.
							} else {
							skippedByProviderRateLimit++;
							if (
								nextCooldownMs === null ||
								distributedCooldownMs < nextCooldownMs
							) {
								nextCooldownMs = distributedCooldownMs;
								nextCooldownEarlyWakeMs = null;
							}
							continue;
							}
						}
						if (
							providerApiKey &&
							blockedApiKeys.has(providerApiKey)
						) {
							skippedByBlockedKey++;
							continue;
						}
						if (shouldRespectCooldowns) {
							const { waitMs, earlyWakeMs } =
								getProviderRateLimitWaitMs(
									providerId,
									modelId,
									modelStats?.rate_limit_rps,
									modelStats?.rate_limit_requests,
									modelStats?.rate_limit_window_ms
								);
							if (waitMs > 0) {
								if (
									tryStaleCooldownProbe(
										providerId,
										modelId,
										'provider rate-limit window'
									)
								) {
									// Probe one candidate despite scheduled provider wait.
								} else {
								skippedByProviderRateLimit++;
								if (
									nextCooldownMs === null ||
									waitMs < nextCooldownMs
								) {
									nextCooldownMs = waitMs;
									nextCooldownEarlyWakeMs =
										earlyWakeMs ?? null;
								}
								continue;
								}
							}
							const distributedPermit =
								await acquireDistributedProviderPermit(
									providerId,
									modelId,
									modelStats
								);
							if (!distributedPermit.allowed) {
								if (
									tryStaleCooldownProbe(
										providerId,
										modelId,
										'distributed provider permit wait'
									)
								) {
									// Probe one candidate despite permit backoff.
								} else {
								skippedByProviderRateLimit++;
								if (
									nextCooldownMs === null ||
									distributedPermit.waitMs < nextCooldownMs
								) {
									nextCooldownMs = distributedPermit.waitMs;
									nextCooldownEarlyWakeMs = null;
								}
								continue;
								}
							}
						}
						if (triedProviderIds.has(providerId)) continue;
						triedProviderIds.add(providerId);
						attemptedSinceCooldown = true;

						if (
							this.isGeminiFamilyProvider(providerId) &&
							inputTokenEstimate > geminiInputTokenLimit
						) {
							lastError = this.buildInputTokenLimitError(
								inputTokenEstimate,
								inputTokenBreakdown,
								geminiInputTokenLimit
							);
							continue;
						}

						const providerConfig = this.ensureProviderConfig(
							providerId,
							selectedProvider
						);
						if (!providerConfig) {
							console.error(
								`Internal config error for provider: ${providerId}. Skipping.`
							);
							lastError = new Error(
								`Internal config error for provider: ${providerId}`
							);
							continue; // Try next provider
						}

						// Inject modelId for Gemini so the SDK calls the correct model instead of a fixed default
						const args = providerConfig.args
							? [...providerConfig.args]
							: [];
						let ProviderClass = providerConfig.class;

						if (this.shouldUseImagenProvider(providerId, modelId)) {
							ProviderClass = ImagenAI;
						}

						const perModelUrl =
							selectedProvider?.provider_urls &&
							selectedProvider.provider_urls[modelId]
								? selectedProvider.provider_urls[modelId]
								: undefined;

						if (ProviderClass === GeminiAI) {
							// Ensure API key stays first arg; if missing, fall back to provider's stored key
							args[0] = args[0] ?? selectedProvider.apiKey ?? '';
							args[1] = modelId;
							if (perModelUrl) args[2] = perModelUrl;
						}
						if (ProviderClass === ImagenAI) {
							args[0] = args[0] ?? selectedProvider.apiKey ?? '';
							args[1] = modelId;
							if (perModelUrl) args[2] = perModelUrl;
						}
						if (
							ProviderClass === OpenAI ||
							ProviderClass === OpenRouterAI ||
							ProviderClass === DeepseekAI
						) {
							if (perModelUrl) {
								args[1] = perModelUrl;
							}
						}

						const providerInstance = new ProviderClass(...args);
						let result: ProviderResponse | null = null;
						let responseEntry: ResponseEntry | null = null;
						let sendMessageError: any = null; // Renamed from attemptError for clarity

						try {
							const attemptStart = Date.now();
							const speedEstimateTps =
								typeof (modelStats as any)?.avg_token_speed ===
									'number' &&
								(modelStats as any).avg_token_speed > 0
									? (modelStats as any).avg_token_speed
									: typeof (modelStats as any)
												?.token_generation_speed ===
												'number' &&
										  (modelStats as any)
												.token_generation_speed > 0
										? (modelStats as any)
												.token_generation_speed
										: this.DEFAULT_GENERATION_SPEED;
							const lastMessage = messages[messages.length - 1];
							const hasRole = messages.some(
								msg =>
									typeof msg.role === 'string' &&
									msg.role.trim().length > 0
							);
							const includeMessages =
								messages.length > 1 || hasRole;
							const messageForProvider: IMessage = {
								...lastMessage,
								...messageOverrides,
								model: { id: modelId }
							};
							if (includeMessages) {
								messageForProvider.messages = messages.map(
									msg => ({
										role:
											typeof msg.role === 'string' &&
											msg.role.trim()
												? msg.role
												: 'user',
										content: msg.content,
										...(Array.isArray(
											(msg as any).tool_calls
										) && (msg as any).tool_calls.length > 0
											? {
													tool_calls: (msg as any)
														.tool_calls
												}
											: {}),
										...(typeof (msg as any).tool_call_id ===
											'string' &&
										(msg as any).tool_call_id.trim()
											? {
													tool_call_id: (
														msg as any
													).tool_call_id.trim()
												}
											: {}),
										...(typeof (msg as any).name ===
											'string' && (msg as any).name.trim()
											? { name: (msg as any).name.trim() }
											: {})
									})
								);
							}
							markProviderRateLimitStart(providerId, modelId);
							result =
								await providerInstance.sendMessage(
									messageForProvider
								);
							const attemptDuration = Date.now() - attemptStart;
							if (result) {
								const estimatedInputTokens = inputTokenEstimate;
								const estimatedOutputTokens =
									estimateTokensFromText(
										result.response || ''
									);
								const { inputTokens, outputTokens } =
									this.normalizeUsage(
										result.usage,
										estimatedInputTokens,
										estimatedOutputTokens
									);
								const tokensGenerated =
									inputTokens + outputTokens;

								const generationTokens =
									inputTokens * TTFT_INPUT_TOKENS_WEIGHT +
									outputTokens * TTFT_OUTPUT_TOKENS_WEIGHT;
								const avgTps =
									outputTokens > 0
										? outputTokens /
											Math.max(
												0.001,
												attemptDuration / 1000
											)
										: 0;
								const effectiveTps =
									speedEstimateTps > 0
										? Math.min(
												speedEstimateTps,
												Math.max(avgTps, 1)
											)
										: Math.max(avgTps, 1);
								const estimatedGenerationMs =
									effectiveTps > 0
										? (generationTokens / effectiveTps) *
											1000
										: 0;
								let estimatedTtftMs = Math.max(
									0,
									attemptDuration - estimatedGenerationMs
								);
								const maxProviderLatency = Math.max(
									0,
									attemptDuration -
										NON_STREAM_MIN_GENERATION_WINDOW_MS
								);
								if (estimatedTtftMs > maxProviderLatency) {
									estimatedTtftMs = maxProviderLatency;
								}
								let providerLatency = Math.max(
									0,
									Math.min(
										Math.round(estimatedTtftMs),
										attemptDuration
									)
								);
								if (
									providerLatency === 0 &&
									attemptDuration > 0 &&
									outputTokens > 0
								) {
									providerLatency = Math.min(
										Math.max(NON_STREAM_MIN_TTFT_MS, 1),
										attemptDuration
									);
								}
								let observedSpeedTps: number | null = null;
								const speedWindowMs = Math.max(
									1,
									attemptDuration - (providerLatency || 0)
								);
								if (outputTokens > 0 && speedWindowMs > 0) {
									let calculatedSpeed =
										outputTokens /
										Math.max(0.001, speedWindowMs / 1000);
									if (
										speedWindowMs <
											NON_STREAM_MIN_GENERATION_WINDOW_MS &&
										avgTps > 0
									) {
										calculatedSpeed = avgTps;
									}
									if (
										!isNaN(calculatedSpeed) &&
										isFinite(calculatedSpeed) &&
										calculatedSpeed > 0
									) {
										observedSpeedTps = calculatedSpeed;
									}
								}
								responseEntry = {
									timestamp: Date.now(),
									response_time: attemptDuration,
									input_tokens: inputTokens,
									output_tokens: outputTokens,
									tokens_generated: tokensGenerated,
									provider_latency: providerLatency,
									observed_speed_tps: observedSpeedTps,
									apiKey: apiKey,
									request_id: requestId
								};
							} else {
								sendMessageError = new Error(
									`Provider ${providerId} returned null result for model ${modelId}.`
								);
							}
						} catch (error: any) {
							if (!(error as any)?.__providerUniqueLogged) {
								void logUniqueProviderError({
									provider: providerId,
									operation: 'sendMessage',
									modelId,
									endpoint:
										selectedProvider.provider_url ||
										undefined,
									error
								});
								if (error && typeof error === 'object') {
									(error as any).__providerUniqueLogged =
										true;
								}
							}
							console.error(
								`Error during sendMessage with ${providerId}/${modelId}:`,
								error
							);
							sendMessageError = error;
						}

							if (
								sendMessageError &&
								this.isRateLimitOrQuotaError(sendMessageError)
							) {
							const retryAfterMs = extractRetryAfterMs(
								String(
									sendMessageError?.message ||
										sendMessageError ||
										''
								)
							);
							const cooldownMs = resolveProviderCooldownMs(
								providerId,
								modelStats,
								retryAfterMs
							);
							if (providerApiKey) {
								blockedApiKeys.add(providerApiKey);
							}
							if (providerApiKey && shouldRespectCooldowns) {
								await setApiKeyCooldownForModel(
									providerApiKey,
									modelId,
									cooldownMs ?? undefined
								);
							}
							await setDistributedProviderCooldown(
								providerId,
								modelId,
								cooldownMs ?? undefined
							);
							console.warn(
								`Rate limit/quota hit for ${providerId}; skipping this key for the remainder of the request.`
							);
								if (
									shouldRespectCooldowns &&
									cooldownMs &&
									cooldownMs > 0
								) {
								nextCooldownMs =
									nextCooldownMs === null
										? cooldownMs
										: Math.min(nextCooldownMs, cooldownMs);
								if (nextCooldownMs === cooldownMs) {
										nextCooldownEarlyWakeMs = null;
									}
								}
								if (this.isGeminiFamilyProvider(providerId)) {
									geminiRateLimitFailureCount += 1;
									if (
										GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST > 0 &&
										geminiRateLimitFailureCount >=
											GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST
									) {
										console.warn(
											`[GeminiRateLimitBudget] Stopping ${modelId} after ${geminiRateLimitFailureCount} Gemini rate-limit/quota failures in one request.`
										);
										lastError = sendMessageError;
										break;
									}
								}
							}
						if (
							sendMessageError &&
							(this.isInvalidProviderCredentialError(
								sendMessageError
							) ||
								sendMessageError?.authFailure === true ||
								sendMessageError?.code ===
									'GEMINI_CATALOG_AUTH_DISABLED' ||
								sendMessageError?.code ===
									'GEMINI_API_DISABLED' ||
								sendMessageError?.code ===
									'GEMINI_PROJECT_AUTH_FAILURE' ||
								sendMessageError?.code ===
									'GEMINI_INVALID_API_KEY')
						) {
							if (providerApiKey) {
								blockedApiKeys.add(providerApiKey);
							}
							if (providerApiKey && shouldRespectCooldowns) {
								await setApiKeyCooldownForModel(
									providerApiKey,
									modelId,
									PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
								);
							}
							await setDistributedProviderCooldown(
								providerId,
								modelId,
								PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
							);
							markProviderFastSkip(
								providerId,
								sendMessageError?.message ||
									'provider auth failure'
							);
						}
						// --- Update Stats & Save (Always, regardless of attempt outcome) ---
						this.updateStatsInBackground(
							providerId,
							modelId,
							responseEntry,
							!!sendMessageError,
							sendMessageError
						);

						// --- Handle Attempt Outcome ---
						const hasMeaningfulResult = Boolean(
							result &&
							((typeof result.response === 'string' &&
								result.response.trim().length > 0) ||
								(Array.isArray(result.tool_calls) &&
									result.tool_calls.length > 0) ||
								(typeof result.reasoning === 'string' &&
									result.reasoning.trim().length > 0))
						);
							if (
								!sendMessageError &&
								result &&
								responseEntry &&
								hasMeaningfulResult
							) {
								if (this.isGeminiFamilyProvider(providerId)) {
									await this.clearGeminiModelNegativeCache(modelId);
								}
								clearProviderFastSkip(providerId);
								return {
									response: result.response,
								latency: result.latency,
								tokenUsage: responseEntry.tokens_generated,
								promptTokens: responseEntry.input_tokens,
								completionTokens: responseEntry.output_tokens,
								providerId: providerId,
								tool_calls: result.tool_calls,
								finish_reason: result.finish_reason,
								reasoning: result.reasoning
							};
						} else {
							lastError =
								sendMessageError ||
								new Error(
									`Provider ${providerId} for model ${modelId} finished in invalid state or stats update failed after success.`
								);
							// Reinstate this important operational warning
							console.warn(
								`Provider ${providerId} failed for model ${modelId}. Error: ${lastError.message}. Trying next provider if available...`
							);
						}
						if (
							sendMessageError &&
							isNonRetryableRequestError(sendMessageError)
						) {
							throw buildNonRetryableRequestError(
								sendMessageError
							);
						}

						if (
							sendMessageError &&
							this.isInsufficientCreditsError(sendMessageError)
						) {
							const added = this.appendCreditFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								selectedProvider,
								modelId,
								requiredCaps,
								triedProviderIds
							);
							if (added > 0) {
								console.warn(
									`Insufficient credits on ${providerId}; added ${added} fallback provider(s) for model ${modelId}.`
								);
							}
						} else if (
							sendMessageError &&
							(this.isRateLimitOrQuotaError(sendMessageError) ||
								isTransientProviderGatewayError(sendMessageError))
						) {
							const failureSignal = this.isRateLimitOrQuotaError(
								sendMessageError
							)
								? 'cooldown'
								: 'transient';
							const added = this.appendRecentFailureFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								selectedProvider,
								modelId,
								requiredCaps,
								triedProviderIds,
								failureSignal
							);
							if (added > 0) {
								console.warn(
									`Transient provider failure on ${providerId}; added ${added} fresh sibling fallback provider(s) for model ${modelId}.`
								);
							}
						}

						// When all current candidates are exhausted, try disabled providers as last resort
						if (
							!disabledFallbackAdded &&
							idx === candidateProviders.length - 1
						) {
							const added = this.appendDisabledFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								modelId,
								requiredCaps,
								triedProviderIds
							);
							if (added > 0) {
								disabledFallbackAdded = true;
								console.warn(
									`All active providers failed for model ${modelId}. Trying ${added} disabled provider(s) as last resort.`
								);
							}
						}
					} // End of loop through candidateProviders
				} finally {
					if (releaseQueueSlot) {
						releaseQueueSlot();
					}
				}

				const hasCooldownSkips =
					skippedByCooldown > 0 || skippedByProviderRateLimit > 0;
				effectiveRateLimitWaitBudgetMs =
					maybeExtendGeminiRateLimitWaitBudget(
						effectiveRateLimitWaitBudgetMs,
						candidateProviders,
						nextCooldownMs,
						modelId,
						false
					);
				const remainingCooldownWaitBudgetMs = Math.max(
					0,
					effectiveRateLimitWaitBudgetMs - cooldownWaitSpentMs
				);
				const shouldRetryAfterCooldown =
					hasCooldownSkips &&
					shouldRespectCooldowns &&
					RATE_LIMIT_WAIT_PER_MESSAGE &&
					nextCooldownMs !== null &&
					!attemptedSinceCooldown &&
					remainingCooldownWaitBudgetMs > 0;
				if (!shouldRetryAfterCooldown) {
					break;
				}
				const effectiveCooldownMs = Math.min(
					nextCooldownMs ?? remainingCooldownWaitBudgetMs,
					remainingCooldownWaitBudgetMs
				);
				const cooldownWaitStartedAt = Date.now();
				logMemoryProfile('provider-cooldown-wait:start', {
					requestId,
					modelId,
					stream: false,
					cooldownMs: effectiveCooldownMs,
					waitBudgetRemainingMs: remainingCooldownWaitBudgetMs,
					totalWaitBudgetMs: effectiveRateLimitWaitBudgetMs,
					earlyWakeMs: nextCooldownEarlyWakeMs,
					requestAgeMs: cooldownWaitStartedAt - requestStartTime
				});
				const waited = await waitForCooldownOrDeadline(
					effectiveCooldownMs,
					requestStartTime,
					REQUEST_DEADLINE_MS,
					true,
					nextCooldownEarlyWakeMs
				);
				const waitElapsedMs = Date.now() - cooldownWaitStartedAt;
				cooldownWaitSpentMs += waitElapsedMs;
				logMemoryProfile('provider-cooldown-wait:end', {
					requestId,
					modelId,
					stream: false,
					cooldownMs: effectiveCooldownMs,
					waitBudgetRemainingMs: Math.max(
						0,
						effectiveRateLimitWaitBudgetMs - cooldownWaitSpentMs
					),
					totalWaitBudgetMs: effectiveRateLimitWaitBudgetMs,
					earlyWakeMs: nextCooldownEarlyWakeMs,
					waited,
					waitElapsedMs,
					requestAgeMs: Date.now() - requestStartTime
				});
				if (!waited) break;
				if (shouldReuseProviderOrder) {
					triedProviderIds.clear();
				}
				blockedApiKeys.clear();
				skippedByCooldown = 0;
				skippedByBlockedKey = 0;
				skippedByProviderRateLimit = 0;
				nextCooldownMs = null;
				nextCooldownEarlyWakeMs = null;
				attemptedSinceCooldown = false;
			}

			// If loop completes without success — build a descriptive error
			const attempted = triedProviderIds.size;
			const allSkipped =
				attempted === 0 &&
				(skippedByCooldown > 0 ||
					skippedByBlockedKey > 0 ||
					skippedByProviderRateLimit > 0);
				let detail: string;
				if (allSkipped) {
					const parts: string[] = [];
				if (skippedByCooldown > 0)
					parts.push(
						`${skippedByCooldown} rate-limited/cooling down`
					);
				if (skippedByBlockedKey > 0)
					parts.push(`${skippedByBlockedKey} blocked by key`);
				if (skippedByProviderRateLimit > 0)
					parts.push(
						`${skippedByProviderRateLimit} rate-limit scheduled`
					);
				detail = `All ${totalCandidates} provider(s) for model ${modelId} are temporarily unavailable (${parts.join(', ')}). Try again shortly.`;
			} else if (attempted > 0 && lastError) {
				detail = `${attempted} provider(s) attempted for model ${modelId}, all failed. Last error: ${lastError.message}`;
				} else {
					detail =
						lastError?.message ||
						`No providers could serve model ${modelId}.`;
				}
				if (this.isGeminiModelId(modelId)) {
					if (
						lastError &&
						this.isModelAccessError(lastError) &&
						this.isGeminiRetiredModelError(lastError)
					) {
						await this.cacheGeminiModelNegativeOutcome(
							modelId,
							lastError,
							null
						);
					} else if (
						nextCooldownMs !== null &&
						(allSkipped ||
							(lastError &&
								this.isRateLimitOrQuotaError(lastError)))
					) {
						await this.cacheGeminiModelNegativeOutcome(
							modelId,
							lastError,
							nextCooldownMs
						);
					}
				}
				console.error(
					`All attempts failed for model ${modelId}. Attempted: ${attempted}, Cooldown: ${skippedByCooldown}, ProviderRateLimit: ${skippedByProviderRateLimit}, Blocked: ${skippedByBlockedKey}. Detail: ${detail}`
				);
			const finalError = new Error(
				`Failed to process request: ${detail}`
			);
			const attemptedProviderList = Array.from(triedProviderIds);
			(finalError as any).modelId = modelId;
			(finalError as any).attemptedProviders = attemptedProviderList;
			(finalError as any).lastProviderId =
				attemptedProviderList.length > 0
					? attemptedProviderList[attemptedProviderList.length - 1]
					: null;
			(finalError as any).lastProviderError = lastError?.message || null;
			(finalError as any).candidateProviders = totalCandidates;
			(finalError as any).skippedByCooldown = skippedByCooldown;
			(finalError as any).skippedByBlockedKey = skippedByBlockedKey;
			(finalError as any).skippedByProviderRateLimit =
				skippedByProviderRateLimit;
			(finalError as any).allSkippedByRateLimit = allSkipped;
			(finalError as any).rateLimitWaitBudgetMs =
				rateLimitWaitBudgetMs;
			if (nextCooldownMs !== null && Number.isFinite(nextCooldownMs)) {
				(finalError as any).retryAfterMs = Math.max(
					1000,
					Math.ceil(nextCooldownMs)
				);
				(finalError as any).retryAfterSeconds = Math.max(
					1,
					Math.ceil(nextCooldownMs / 1000)
				);
			}
			throw finalError;
		};

		return execute();
	}

	async *handleStreamingMessages(
		messages: IMessage[],
		modelId: string,
		apiKey: string,
		options?: HandleStreamingOptions
	): AsyncGenerator<any, void, unknown> {
		const rateLimitWaitBudgetMs =
			typeof options?.rateLimitWaitBudgetMs === 'number' &&
			Number.isFinite(options.rateLimitWaitBudgetMs)
				? Math.max(0, Math.floor(options.rateLimitWaitBudgetMs))
				: RATE_LIMIT_TOTAL_WAIT_BUDGET_MS;
		const allowStaleCooldownProbe =
			options?.allowStaleCooldownProbe === true;
		const messageOverrides = this.extractMessageOverrides(options);
		const shouldUseRequestQueue = !options?.skipQueue;
		const requestQueue = getRequestQueueForLane(options?.queueLane);
		if (!messages?.length || !modelId || !apiKey)
			throw new Error('Invalid arguments for streaming');
		if (!messageHandler)
			throw new Error('Service temporarily unavailable.');
			modelId = this.applyModelReroute(modelId);

			await this.refreshModelCapabilities();
			modelId = await this.resolveModelIdForRequest(modelId);
			const cachedGeminiModelError =
				await this.getGeminiModelNegativeCacheError(modelId);
			if (cachedGeminiModelError) throw cachedGeminiModelError;
			messages = this.relaxUnsupportedToolCalling(modelId, messages);
			const requiredCaps = this.detectRequiredCapabilities(messages, modelId);
			this.validateModelCapabilities(modelId, messages);

			const validationResult = await validateApiKeyAndUsage(apiKey);
		if (
			!validationResult.valid ||
			!validationResult.userData ||
			!validationResult.tierLimits
		) {
			throw new Error(
				`Unauthorized: ${validationResult.error || 'Invalid key/config.'}`
			);
		}

			const userData: UserData = validationResult.userData;
			const tierLimits: TierData = validationResult.tierLimits;
			const userTierName = userData.tier;
			assertModelAllowedForTier(modelId, tierLimits);

			const allProvidersOriginal =
				await dataManager.load<LoadedProviders>('providers');
			let candidateProviders: LoadedProviderData[];
			try {
				candidateProviders = this.prepareCandidateProviders(
					allProvidersOriginal,
					modelId,
					tierLimits,
					userTierName
				);
			} catch (error: any) {
				if (
					this.isGeminiModelId(modelId) &&
					/no currently active provider supports model/i.test(
						String(error?.message || '')
					)
				) {
					await this.cacheGeminiModelNegativeOutcome(
						modelId,
						null,
						GEMINI_MODEL_NEGATIVE_CACHE_RATE_LIMIT_FLOOR_MS
					);
					const cachedGeminiModelError =
						await this.getGeminiModelNegativeCacheError(modelId);
					if (cachedGeminiModelError) throw cachedGeminiModelError;
				}
				throw error;
			}
			candidateProviders = this.filterProvidersByCapabilitySkips(
				candidateProviders,
				modelId,
			requiredCaps
		);
		candidateProviders = this.preferStableToolCallingProviders(
			candidateProviders,
			modelId,
			requiredCaps
		);
		const filteredGeminiProviders = candidateProviders.filter(
			(provider: LoadedProviderData) =>
				!shouldSkipGeminiProviderForMessage(provider, messages)
		);
		if (filteredGeminiProviders.length > 0) {
			candidateProviders = filteredGeminiProviders;
		}
		if (candidateProviders.length === 0) {
			throw new Error(
				`No providers available for model ${modelId} after capability filtering.`
			);
		}

		const inputTokenBreakdown =
			estimateTokensFromMessagesBreakdown(messages);
		const inputTokenEstimate = inputTokenBreakdown.total;
		const geminiInputTokenLimit = this.getGeminiInputTokenLimit(modelId);
		if (
			inputTokenEstimate > geminiInputTokenLimit &&
			candidateProviders.every(p => this.isGeminiFamilyProvider(p.id))
		) {
			throw this.buildInputTokenLimitError(
				inputTokenEstimate,
				inputTokenBreakdown,
				geminiInputTokenLimit
			);
		}

		let lastError: any = null;
		const triedProviderIds = new Set<string>();
		const blockedApiKeys = new Set<string>();
		const shouldRespectCooldowns = !RATE_LIMIT_SKIP_WAIT;
		const shouldReuseProviderOrder =
			shouldRespectCooldowns && RATE_LIMIT_WAIT_PER_MESSAGE;
		let skippedByCooldown = 0;
		let skippedByBlockedKey = 0;
		let skippedByProviderRateLimit = 0;
		let disabledFallbackAdded = false;
		const requestStartTime = Date.now();
		const totalCandidates = candidateProviders.length;
		let effectiveRateLimitWaitBudgetMs = rateLimitWaitBudgetMs;
		let cooldownWaitSpentMs = 0;
			let nextCooldownMs: number | null = null;
			let nextCooldownEarlyWakeMs: number | null = null;
			let attemptedSinceCooldown = false;
			let geminiRateLimitFailureCount = 0;
			let staleCooldownProbeUsed = false;
		const tryStaleCooldownProbe = (
			providerId: string,
			modelId: string,
			reason: string
		): boolean => {
			if (!allowStaleCooldownProbe || staleCooldownProbeUsed) {
				return false;
			}
			staleCooldownProbeUsed = true;
			console.warn(
				`[CooldownProbe] Ignoring ${reason} once for internal streaming request on ${providerId}/${modelId}.`
			);
			return true;
		};
		for (;;) {
			let releaseQueueSlot: (() => void) | null = null;
			let queueReleased = false;
			const releaseQueue = () => {
				if (queueReleased) return;
				queueReleased = true;
				if (releaseQueueSlot) {
					releaseQueueSlot();
					releaseQueueSlot = null;
				}
			};
			try {
				if (shouldUseRequestQueue) {
					releaseQueueSlot = await requestQueue.acquire();
				}
				for (let idx = 0; idx < candidateProviders.length; idx++) {
					// Check request-level deadline before each attempt
					const elapsed = Date.now() - requestStartTime;
					if (
						REQUEST_DEADLINE_MS > 0 &&
						elapsed >= REQUEST_DEADLINE_MS
					) {
						console.warn(
							`Streaming request deadline (${REQUEST_DEADLINE_MS}ms) exceeded after ${elapsed}ms and ${triedProviderIds.size} provider(s) for model ${modelId}. Aborting.`
						);
						if (!lastError)
							lastError = new Error(
								`Request deadline exceeded (${REQUEST_DEADLINE_MS}ms)`
							);
						idx = candidateProviders.length;
						break;
					}

						const selectedProviderData = candidateProviders[idx];
						const providerId = selectedProviderData.id;
						const providerApiKey = selectedProviderData.apiKey ?? '';
						const modelStats = selectedProviderData?.models?.[modelId];
						const fastSkipRemainingMs =
							getProviderFastSkipRemainingMs(providerId);
						if (fastSkipRemainingMs !== null) {
							if (
								tryStaleCooldownProbe(
									providerId,
									modelId,
									'provider fast-skip'
								)
							) {
								// Probe one candidate despite fast-skip state.
							} else {
								skippedByCooldown++;
								if (
									nextCooldownMs === null ||
									fastSkipRemainingMs < nextCooldownMs
								) {
									nextCooldownMs = fastSkipRemainingMs;
									nextCooldownEarlyWakeMs = null;
								}
								continue;
							}
						}
					if (
						providerApiKey &&
						(await isApiKeyCoolingDownForModel(
							providerApiKey,
							modelId
						))
					) {
						if (
							tryStaleCooldownProbe(
								providerId,
								modelId,
								'api-key cooldown'
							)
						) {
							// Probe one candidate despite stale cooldown state.
						} else {
						skippedByCooldown++;
						if (shouldRespectCooldowns) {
							const remainingMs =
								await getApiKeyCooldownMsForModel(
									providerApiKey,
									modelId
								);
							if (remainingMs !== null) {
								nextCooldownMs =
									nextCooldownMs === null
										? remainingMs
										: Math.min(nextCooldownMs, remainingMs);
								if (nextCooldownMs === remainingMs) {
									nextCooldownEarlyWakeMs = null;
								}
							}
						}
						continue;
						}
					}
					const distributedCooldownMs =
						await getDistributedProviderCooldownMs(
							providerId,
							modelId
						);
					if (
						distributedCooldownMs !== null &&
						distributedCooldownMs > 0
					) {
						if (
							tryStaleCooldownProbe(
								providerId,
								modelId,
								'distributed provider cooldown'
							)
						) {
							// Probe one candidate despite stale distributed cooldown state.
						} else {
						skippedByProviderRateLimit++;
						if (
							nextCooldownMs === null ||
							distributedCooldownMs < nextCooldownMs
						) {
							nextCooldownMs = distributedCooldownMs;
							nextCooldownEarlyWakeMs = null;
						}
						continue;
						}
					}
					if (providerApiKey && blockedApiKeys.has(providerApiKey)) {
						skippedByBlockedKey++;
						continue;
					}
					if (shouldRespectCooldowns) {
						const { waitMs, earlyWakeMs } =
							getProviderRateLimitWaitMs(
								providerId,
								modelId,
								modelStats?.rate_limit_rps,
								modelStats?.rate_limit_requests,
								modelStats?.rate_limit_window_ms
							);
						if (waitMs > 0) {
							if (
								tryStaleCooldownProbe(
									providerId,
									modelId,
									'provider rate-limit window'
								)
							) {
								// Probe one candidate despite scheduled provider wait.
							} else {
							skippedByProviderRateLimit++;
							if (
								nextCooldownMs === null ||
								waitMs < nextCooldownMs
							) {
								nextCooldownMs = waitMs;
								nextCooldownEarlyWakeMs = earlyWakeMs ?? null;
							}
							continue;
							}
						}
						const distributedPermit =
							await acquireDistributedProviderPermit(
								providerId,
								modelId,
								modelStats
							);
						if (!distributedPermit.allowed) {
							if (
								tryStaleCooldownProbe(
									providerId,
									modelId,
									'distributed provider permit wait'
								)
							) {
								// Probe one candidate despite permit backoff.
							} else {
							skippedByProviderRateLimit++;
							if (
								nextCooldownMs === null ||
								distributedPermit.waitMs < nextCooldownMs
							) {
								nextCooldownMs = distributedPermit.waitMs;
								nextCooldownEarlyWakeMs = null;
							}
							continue;
							}
						}
					}
					if (triedProviderIds.has(providerId)) continue;
					triedProviderIds.add(providerId);
					attemptedSinceCooldown = true;

					if (
						this.isGeminiFamilyProvider(providerId) &&
						inputTokenEstimate > geminiInputTokenLimit
					) {
						lastError = this.buildInputTokenLimitError(
							inputTokenEstimate,
							inputTokenBreakdown,
							geminiInputTokenLimit
						);
						continue;
					}
					const providerConfig = this.ensureProviderConfig(
						providerId,
						selectedProviderData
					);

					if (!providerConfig) {
						console.error(
							`Internal config error for provider: ${providerId}. Skipping.`
						);
						lastError = new Error(
							`Internal config error for provider: ${providerId}`
						);
						continue;
					}

					const streamArgs = providerConfig.args
						? [...providerConfig.args]
						: [];
					let StreamProviderClass = providerConfig.class;

					if (this.shouldUseImagenProvider(providerId, modelId)) {
						StreamProviderClass = ImagenAI;
					}

					if (StreamProviderClass === GeminiAI) {
						streamArgs[0] =
							streamArgs[0] ?? selectedProviderData.apiKey ?? '';
						streamArgs[1] = modelId;
					}
					if (StreamProviderClass === ImagenAI) {
						streamArgs[0] =
							streamArgs[0] ?? selectedProviderData.apiKey ?? '';
						streamArgs[1] = modelId;
					}

					const providerInstance = new StreamProviderClass(
						...streamArgs
					);

					try {
						const lastMessage = messages[messages.length - 1];
						const hasRole = messages.some(
							msg =>
								typeof msg.role === 'string' &&
								msg.role.trim().length > 0
						);
						const includeMessages = messages.length > 1 || hasRole;
						const messageForProvider: IMessage = {
							...lastMessage,
							...messageOverrides,
							model: { id: modelId }
						};
						if (includeMessages) {
							messageForProvider.messages = messages.map(msg => ({
								role:
									typeof msg.role === 'string' &&
									msg.role.trim()
										? msg.role
										: 'user',
								content: msg.content,
								...(Array.isArray((msg as any).tool_calls) &&
								(msg as any).tool_calls.length > 0
									? { tool_calls: (msg as any).tool_calls }
									: {}),
								...(typeof (msg as any).tool_call_id ===
									'string' && (msg as any).tool_call_id.trim()
									? {
											tool_call_id: (
												msg as any
											).tool_call_id.trim()
										}
									: {}),
								...(typeof (msg as any).name === 'string' &&
								(msg as any).name.trim()
									? { name: (msg as any).name.trim() }
									: {})
							}));
						}

						if (
							!options?.disablePassthrough &&
							selectedProviderData.streamingCompatible &&
							typeof providerInstance.createPassthroughStream ===
								'function'
						) {
							try {
								markProviderRateLimitStart(providerId, modelId);
								const passthrough =
									await providerInstance.createPassthroughStream(
										messageForProvider
									);
								if (passthrough?.upstream) {
									releaseQueue();
									console.log(
										`[StreamPassthrough] Activated for provider ${providerId} (${passthrough.mode}).`
									);
									yield {
										type: 'passthrough',
										providerId,
										passthrough,
										promptTokens: inputTokenEstimate,
										startedAt: Date.now()
									};
									return;
								}
							} catch (passthroughError: any) {
								console.warn(
									`[StreamPassthrough] Fallback to normalized streaming for provider ${providerId}: ${passthroughError?.message || 'unknown passthrough setup error'}`
								);
							}
						}

						if (
							selectedProviderData.streamingCompatible &&
							typeof providerInstance.sendMessageStream ===
								'function'
						) {
							const streamStart = Date.now();
							markProviderRateLimitStart(providerId, modelId);
							const stream =
								providerInstance.sendMessageStream(
									messageForProvider
								);
							releaseQueue();
							let fullResponse = '';
							let totalLatency = 0;
							let chunkCount = 0;
							let firstChunkLatency: number | null = null;
							let toolCalls: any[] | undefined;
							let finishReason: string | undefined;
							let sawReasoning = false;
							const streamIterator = (
								stream as AsyncIterable<any>
							)[Symbol.asyncIterator]();

							while (true) {
								const streamElapsed = Date.now() - requestStartTime;
								if (
									REQUEST_DEADLINE_MS > 0 &&
									streamElapsed >= REQUEST_DEADLINE_MS
								) {
									throw new Error(
										`Request deadline exceeded (${REQUEST_DEADLINE_MS}ms)`
									);
								}
								const remainingDeadlineMs =
									REQUEST_DEADLINE_MS > 0
										? Math.max(
												1_000,
												REQUEST_DEADLINE_MS - streamElapsed
											)
										: PROVIDER_STREAM_IDLE_TIMEOUT_MS;
								const nextStreamResult =
									await readNextProviderStreamChunkWithTimeout(
										streamIterator,
										Math.min(
											PROVIDER_STREAM_IDLE_TIMEOUT_MS,
											remainingDeadlineMs
										),
										providerId,
										modelId
									);
								if (nextStreamResult.done) break;
								const {
									chunk,
									latency,
									response,
									tool_calls,
									finish_reason,
									reasoning
								} = nextStreamResult.value as any;
								fullResponse = response;
								totalLatency += latency || 0;
								chunkCount++;
								if (
									firstChunkLatency === null &&
									chunk &&
									chunk.length > 0
								) {
									firstChunkLatency = latency || 0;
								}
								if (
									Array.isArray(tool_calls) &&
									tool_calls.length > 0
								)
									toolCalls = tool_calls;
								if (finish_reason) finishReason = finish_reason;
								if (
									typeof reasoning === 'string' &&
									reasoning.trim().length > 0
								)
									sawReasoning = true;
								yield {
									type: 'chunk',
									chunk,
									latency,
									tool_calls,
									finish_reason,
									reasoning
								};
							}

							if (
								fullResponse.trim().length === 0 &&
								(!toolCalls || toolCalls.length === 0) &&
								!sawReasoning
							) {
								throw new Error(
									`Provider ${providerId} returned an empty streaming response for model ${modelId}.`
								);
							}

							const totalResponseTime = Date.now() - streamStart;
							const inputTokens = inputTokenEstimate;
							const outputTokens =
								estimateTokensFromText(fullResponse);

							let providerLatency: number | null = null;
							if (
								firstChunkLatency !== null &&
								firstChunkLatency > 0
							) {
								providerLatency = Math.min(
									Math.round(firstChunkLatency),
									totalResponseTime
								);
							} else {
								providerLatency = Math.max(
									0,
									Math.round(totalResponseTime)
								);
							}
							let observedSpeedTps: number | null = null;

							if (outputTokens > 0) {
								const speedWindowMs = Math.max(
									1,
									totalResponseTime - (providerLatency || 0)
								);
								const generationWindow = Math.max(
									speedWindowMs,
									STREAM_MIN_GENERATION_WINDOW_MS
								);
								const generationTimeSeconds = Math.max(
									0.001,
									generationWindow / 1000
								);
								const calculatedSpeed =
									outputTokens / generationTimeSeconds;
								if (
									!isNaN(calculatedSpeed) &&
									isFinite(calculatedSpeed)
								) {
									observedSpeedTps = calculatedSpeed;
								}
							}

							const responseEntry: ResponseEntry = {
								timestamp: Date.now(),
								response_time: totalResponseTime,
								input_tokens: inputTokens,
								output_tokens: outputTokens,
								tokens_generated: inputTokens + outputTokens,
								provider_latency: providerLatency,
								observed_speed_tps: observedSpeedTps,
								apiKey: apiKey,
								request_id: options?.requestId
							};

							this.updateStatsInBackground(
								providerId,
								modelId,
								responseEntry,
								false
							);
							if (this.isGeminiFamilyProvider(providerId)) {
								await this.clearGeminiModelNegativeCache(modelId);
							}
							clearProviderFastSkip(providerId);

							yield {
								type: 'final',
								response: fullResponse,
								tokenUsage: inputTokens + outputTokens,
								promptTokens: inputTokens,
								completionTokens: outputTokens,
								providerId: providerId,
								latency: totalResponseTime,
								providerLatency: providerLatency,
								observedSpeedTps: observedSpeedTps,
								tool_calls: toolCalls,
								finish_reason: finishReason
							};
							return;
						}

						console.log(
							`Provider ${providerId} is not streaming compatible. Simulating stream.`
						);
						releaseQueue();
						const result = await this.handleMessages(
							messages,
							modelId,
							apiKey,
							options?.requestId,
							{ skipQueue: true }
						);
						const responseText = result.response;
						const chunkSize = 5;
						for (
							let i = 0;
							i < responseText.length;
							i += chunkSize
						) {
							const chunk = responseText.substring(
								i,
								i + chunkSize
							);
							yield {
								type: 'chunk',
								chunk,
								latency: result.latency
							};
							await new Promise(resolve =>
								setTimeout(resolve, 2)
							);
						}

						yield {
							type: 'final',
							response: responseText,
							tokenUsage: result.tokenUsage || 0,
							providerId: result.providerId,
							latency: result.latency,
							tool_calls: result.tool_calls,
							finish_reason: result.finish_reason
						};
						return;
					} catch (error: any) {
						if (!(error as any)?.__providerUniqueLogged) {
							void logUniqueProviderError({
								provider: providerId,
								operation: 'sendMessageStream',
								modelId,
								endpoint:
									selectedProviderData.provider_url ||
									undefined,
								error
							});
							if (error && typeof error === 'object') {
								(error as any).__providerUniqueLogged = true;
							}
						}
						this.updateStatsInBackground(
							providerId,
							modelId,
							null,
							true,
							error
						);
						console.warn(
							`Stream failed for provider ${providerId}. Error: ${error.message}. Trying next provider if available...`
						);
						lastError = error;
						if (
							this.isInvalidProviderCredentialError(error) ||
							error?.authFailure === true ||
							error?.code === 'GEMINI_CATALOG_AUTH_DISABLED' ||
							error?.code === 'GEMINI_API_DISABLED' ||
							error?.code === 'GEMINI_PROJECT_AUTH_FAILURE' ||
							error?.code === 'GEMINI_INVALID_API_KEY'
						) {
							if (providerApiKey) {
								blockedApiKeys.add(providerApiKey);
							}
							if (providerApiKey && shouldRespectCooldowns) {
								await setApiKeyCooldownForModel(
									providerApiKey,
									modelId,
									PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
								);
							}
							await setDistributedProviderCooldown(
								providerId,
								modelId,
								PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
							);
							markProviderFastSkip(
								providerId,
								error?.message || 'provider auth failure'
							);
						}
						if (isNonRetryableRequestError(error)) {
							throw buildNonRetryableRequestError(error);
						}

						if (this.isRateLimitOrQuotaError(error)) {
							const retryAfterMs = extractRetryAfterMs(
								String(error?.message || error || '')
							);
							const cooldownMs = resolveProviderCooldownMs(
								providerId,
								modelStats,
								retryAfterMs
							);
							if (providerApiKey) {
								blockedApiKeys.add(providerApiKey);
							}
							if (providerApiKey && shouldRespectCooldowns) {
								await setApiKeyCooldownForModel(
									providerApiKey,
									modelId,
									cooldownMs ?? undefined
								);
							}
							await setDistributedProviderCooldown(
								providerId,
								modelId,
								cooldownMs ?? undefined
							);
							console.warn(
								`Rate limit/quota hit for ${providerId}; skipping this key for the remainder of the request.`
							);
							if (
								shouldRespectCooldowns &&
								cooldownMs &&
								cooldownMs > 0
							) {
								nextCooldownMs =
									nextCooldownMs === null
										? cooldownMs
										: Math.min(nextCooldownMs, cooldownMs);
								if (nextCooldownMs === cooldownMs) {
									nextCooldownEarlyWakeMs = null;
								}
							}
							if (this.isGeminiFamilyProvider(providerId)) {
								geminiRateLimitFailureCount += 1;
								if (
									GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST > 0 &&
									geminiRateLimitFailureCount >=
										GEMINI_MAX_RATE_LIMIT_FAILURES_PER_REQUEST
								) {
									console.warn(
										`[GeminiRateLimitBudget] Stopping ${modelId} after ${geminiRateLimitFailureCount} Gemini rate-limit/quota failures in one streaming request.`
									);
									lastError = error;
									break;
								}
							}
						}
						if (this.isInsufficientCreditsError(error)) {
							const added = this.appendCreditFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								selectedProviderData,
								modelId,
								requiredCaps,
								triedProviderIds
							);
							if (added > 0) {
								console.warn(
									`Insufficient credits on ${providerId}; added ${added} fallback provider(s) for model ${modelId}.`
								);
							}
						} else if (
							this.isRateLimitOrQuotaError(error) ||
							isTransientProviderGatewayError(error)
						) {
							const failureSignal = this.isRateLimitOrQuotaError(error)
								? 'cooldown'
								: 'transient';
							const added = this.appendRecentFailureFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								selectedProviderData,
								modelId,
								requiredCaps,
								triedProviderIds,
								failureSignal
							);
							if (added > 0) {
								console.warn(
									`Transient provider failure on ${providerId}; added ${added} fresh sibling fallback provider(s) for model ${modelId}.`
								);
							}
						}

						// When all current candidates are exhausted, try disabled providers as last resort
						if (
							!disabledFallbackAdded &&
							idx === candidateProviders.length - 1
						) {
							const added = this.appendDisabledFallbackProviders(
								allProvidersOriginal,
								candidateProviders,
								modelId,
								requiredCaps,
								triedProviderIds
							);
							if (added > 0) {
								disabledFallbackAdded = true;
								console.warn(
									`All active streaming providers failed for model ${modelId}. Trying ${added} disabled provider(s) as last resort.`
								);
							}
						}
						continue;
					}
				}
			} finally {
				releaseQueue();
			}

			const hasCooldownSkips =
				skippedByCooldown > 0 || skippedByProviderRateLimit > 0;
			effectiveRateLimitWaitBudgetMs =
				maybeExtendGeminiRateLimitWaitBudget(
					effectiveRateLimitWaitBudgetMs,
					candidateProviders,
					nextCooldownMs,
					modelId,
					true
				);
			const remainingCooldownWaitBudgetMs = Math.max(
				0,
				effectiveRateLimitWaitBudgetMs - cooldownWaitSpentMs
			);
			const shouldRetryAfterCooldown =
				hasCooldownSkips &&
				shouldRespectCooldowns &&
				RATE_LIMIT_WAIT_PER_MESSAGE &&
				nextCooldownMs !== null &&
				!attemptedSinceCooldown &&
				remainingCooldownWaitBudgetMs > 0;
			if (!shouldRetryAfterCooldown) {
				break;
			}
			const effectiveCooldownMs = Math.min(
				nextCooldownMs ?? remainingCooldownWaitBudgetMs,
				remainingCooldownWaitBudgetMs
			);
			const cooldownWaitStartedAt = Date.now();
			logMemoryProfile('provider-cooldown-wait:start', {
				requestId: options?.requestId,
				modelId,
				stream: true,
				cooldownMs: effectiveCooldownMs,
				waitBudgetRemainingMs: remainingCooldownWaitBudgetMs,
				totalWaitBudgetMs: effectiveRateLimitWaitBudgetMs,
				earlyWakeMs: nextCooldownEarlyWakeMs,
				requestAgeMs: cooldownWaitStartedAt - requestStartTime
			});
			const waited = await waitForCooldownOrDeadline(
				effectiveCooldownMs,
				requestStartTime,
				REQUEST_DEADLINE_MS,
				true,
				nextCooldownEarlyWakeMs
			);
			const waitElapsedMs = Date.now() - cooldownWaitStartedAt;
			cooldownWaitSpentMs += waitElapsedMs;
			logMemoryProfile('provider-cooldown-wait:end', {
				requestId: options?.requestId,
				modelId,
				stream: true,
				cooldownMs: effectiveCooldownMs,
				waitBudgetRemainingMs: Math.max(
					0,
					effectiveRateLimitWaitBudgetMs - cooldownWaitSpentMs
				),
				totalWaitBudgetMs: effectiveRateLimitWaitBudgetMs,
				earlyWakeMs: nextCooldownEarlyWakeMs,
				waited,
				waitElapsedMs,
				requestAgeMs: Date.now() - requestStartTime
			});
			if (!waited) break;
			if (shouldReuseProviderOrder) {
				triedProviderIds.clear();
			}
			blockedApiKeys.clear();
			skippedByCooldown = 0;
			skippedByBlockedKey = 0;
			skippedByProviderRateLimit = 0;
			nextCooldownMs = null;
			nextCooldownEarlyWakeMs = null;
			attemptedSinceCooldown = false;
		}

		// Build a descriptive error
		const attempted = triedProviderIds.size;
		const allSkipped =
			attempted === 0 &&
			(skippedByCooldown > 0 ||
				skippedByBlockedKey > 0 ||
				skippedByProviderRateLimit > 0);
			let detail: string;
			if (allSkipped) {
				const parts: string[] = [];
			if (skippedByCooldown > 0)
				parts.push(`${skippedByCooldown} rate-limited/cooling down`);
			if (skippedByBlockedKey > 0)
				parts.push(`${skippedByBlockedKey} blocked by key`);
			if (skippedByProviderRateLimit > 0)
				parts.push(
					`${skippedByProviderRateLimit} rate-limit scheduled`
				);
			detail = `All ${totalCandidates} provider(s) for model ${modelId} are temporarily unavailable (${parts.join(', ')}). Try again shortly.`;
		} else if (attempted > 0 && lastError) {
			detail = `${attempted} provider(s) attempted for model ${modelId}, all failed. Last error: ${lastError.message}`;
			} else {
				detail =
					lastError?.message ||
					`No providers could serve model ${modelId}.`;
			}
			if (this.isGeminiModelId(modelId)) {
				if (
					lastError &&
					this.isModelAccessError(lastError) &&
					this.isGeminiRetiredModelError(lastError)
				) {
					await this.cacheGeminiModelNegativeOutcome(
						modelId,
						lastError,
						null
					);
				} else if (
					nextCooldownMs !== null &&
					(allSkipped ||
						(lastError &&
							this.isRateLimitOrQuotaError(lastError)))
				) {
					await this.cacheGeminiModelNegativeOutcome(
						modelId,
						lastError,
						nextCooldownMs
					);
				}
			}
			console.error(
				`All streaming attempts failed for model ${modelId}. Attempted: ${attempted}, Cooldown: ${skippedByCooldown}, ProviderRateLimit: ${skippedByProviderRateLimit}, Blocked: ${skippedByBlockedKey}. Detail: ${detail}`
			);
		const finalError = new Error(
			`Failed to process streaming request: ${detail}`
		);
		const attemptedProviderList = Array.from(triedProviderIds);
		(finalError as any).modelId = modelId;
		(finalError as any).attemptedProviders = attemptedProviderList;
		(finalError as any).lastProviderId =
			attemptedProviderList.length > 0
				? attemptedProviderList[attemptedProviderList.length - 1]
				: null;
		(finalError as any).lastProviderError = lastError?.message || null;
		(finalError as any).candidateProviders = totalCandidates;
		(finalError as any).skippedByCooldown = skippedByCooldown;
		(finalError as any).skippedByBlockedKey = skippedByBlockedKey;
		(finalError as any).skippedByProviderRateLimit =
			skippedByProviderRateLimit;
		(finalError as any).allSkippedByRateLimit = allSkipped;
		(finalError as any).rateLimitWaitBudgetMs = rateLimitWaitBudgetMs;
		if (nextCooldownMs !== null && Number.isFinite(nextCooldownMs)) {
			(finalError as any).retryAfterMs = Math.max(
				1000,
				Math.ceil(nextCooldownMs)
			);
			(finalError as any).retryAfterSeconds = Math.max(
				1,
				Math.ceil(nextCooldownMs / 1000)
			);
		}
		throw finalError;
	}

	private updateStatsInBackground(
		providerId: string,
		modelId: string,
		responseEntry: ResponseEntry | null,
		isError: boolean,
		attemptError?: any
	) {
		const { index, pending, dropped } = this.enqueueProviderStatsUpdate({
			providerId,
			modelId,
			responseEntry,
			isError,
			attemptError
		});

		if (dropped) {
			console.warn(
				`[ProviderStats] Dropped oldest buffered stats update on worker ${index + 1}/${providerStatsQueues.length} ` +
					`for ${providerId}/${modelId} because the buffer reached ${this.providerStatsBufferMaxPending} pending update(s).`
			);
		}

		this.scheduleProviderStatsFlush(
			index,
			pending >= this.providerStatsBatchSize
		);
	}
}

// Token estimation constants/functions now imported from '../modules/tokenEstimation.js'
// Error classification functions now imported from '../modules/errorClassification.js'
const GEMINI_INPUT_TOKEN_LIMIT = readEnvNumber(
	'GEMINI_INPUT_TOKEN_LIMIT',
	1_048_576
);

async function readNextProviderStreamChunkWithTimeout<T>(
	iterator: AsyncIterator<T>,
	timeoutMs: number,
	providerId: string,
	modelId: string
): Promise<IteratorResult<T>> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return iterator.next();
	}

	let timedOut = false;
	let timeoutId: NodeJS.Timeout | null = null;
	const nextPromise = iterator.next().catch(error => {
		if (timedOut) {
			return new Promise<IteratorResult<T>>(() => {});
		}
		throw error;
	});

	const timeoutPromise = new Promise<IteratorResult<T>>((_, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			try {
				const maybeReturn = iterator.return?.();
				if (
					maybeReturn &&
					typeof (maybeReturn as Promise<unknown>).catch === 'function'
				) {
					void (maybeReturn as Promise<unknown>).catch(() => {});
				}
			} catch {
				// Ignore iterator shutdown errors during timeout handling.
			}

			const timeoutError = new Error(
				`Provider ${providerId} stream idle timeout after ${timeoutMs}ms for model ${modelId}.`
			);
			(timeoutError as any).status = 504;
			(timeoutError as any).statusCode = 504;
			(timeoutError as any).code = 'PROVIDER_STREAM_IDLE_TIMEOUT';
			(timeoutError as any).retryable = true;
			(timeoutError as any).failureOrigin = 'upstream_provider';
			reject(timeoutError);
		}, timeoutMs);
		if (typeof timeoutId.unref === 'function') {
			timeoutId.unref();
		}
	});

	try {
		return await Promise.race([nextPromise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

function isGeminiUnsupportedRemoteMediaUrlError(error: any): boolean {
	const message = String(error?.message || '').toLowerCase();
	const code = String(error?.code || '').toUpperCase();
	return (
		code === 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL' ||
		message.includes(
			'gemini:invalid_argument:unsupported_remote_media_url'
		) ||
		message.includes('cannot fetch content from the provided url')
	);
}

function isProviderSwitchWorthlessError(error: any): boolean {
	return (
		error?.providerSwitchWorthless === true ||
		error?.requestRetryWorthless === true ||
		isGeminiUnsupportedRemoteMediaUrlError(error) ||
		error?.code === 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL' ||
		/Cannot fetch content from the provided URL/i.test(
			String(error?.message || '')
		)
	);
}

function isNonRetryableRequestError(error: any): boolean {
	return (
		isProviderSwitchWorthlessError(error) ||
		error?.requestRetryWorthless === true
	);
}

function toProbeSkipReason(error: any): string {
	if (isProviderSwitchWorthlessError(error)) return 'unsupported';
	const message = String(error?.message || '').toLowerCase();
	if (message.includes('rate limit') || error?.status === 429)
		return 'rate limit';
	if (message.includes('timeout') || message.includes('timed out'))
		return 'timeout';
	return 'unsupported';
}

function toNonRetryableRequestErrorMessage(error: any): string {
	const clientMessage = String(error?.clientMessage || '').trim();
	if (clientMessage) return clientMessage;
	if (isGeminiUnsupportedRemoteMediaUrlError(error)) {
		return 'Invalid request: one or more remote media URLs could not be fetched by the selected provider. Use a publicly accessible URL or inline/base64 media content.';
	}
	return String(error?.message || 'Invalid request');
}

function buildNonRetryableRequestError(error: any): Error {
	const message = toNonRetryableRequestErrorMessage(error);
	const wrapped = new Error(message);
	const status = Number(error?.status ?? error?.statusCode ?? 400);
	(wrapped as any).status =
		Number.isFinite(status) && status > 0 ? status : 400;
	(wrapped as any).code = error?.code || 'INVALID_REQUEST';
	(wrapped as any).retryable = false;
	(wrapped as any).clientMessage = message;
	(wrapped as any).providerSwitchWorthless = true;
	(wrapped as any).requestRetryWorthless = true;
	return wrapped;
}

function collectRemoteMediaUrls(value: unknown, acc: string[] = []): string[] {
	if (!value) return acc;
	if (typeof value === 'string') {
		if (/^https?:\/\//i.test(value)) acc.push(value);
		return acc;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectRemoteMediaUrls(item, acc);
		return acc;
	}
	if (typeof value === 'object') {
		for (const nested of Object.values(value as Record<string, unknown>)) {
			collectRemoteMediaUrls(nested, acc);
		}
	}
	return acc;
}

function messageContainsRemoteMediaUrl(message: any): boolean {
	return collectRemoteMediaUrls(message).length > 0;
}

function hasCooldownManagedProviderFailureSignal(provider: any): boolean {
	const lastError = String(
		provider?.lastError || provider?.last_error || provider?.error || ''
	);
	const disabledReason = String(
		provider?.disabled_reason || provider?.disabledReason || ''
	);
	const code = provider?.lastErrorCode || provider?.last_error_code;
	const status = Number(provider?.lastStatus || provider?.last_status || 0);
	return isRateLimitOrQuotaErrorShared({
		message: `${lastError} ${disabledReason}`.trim(),
		code,
		status,
	});
}

function shouldSkipGeminiProviderForMessage(
	provider: any,
	message: any
): boolean {
	const providerId = String(provider?.id || '').toLowerCase();
	const providerType = String(
		provider?.provider || provider?.type || ''
	).toLowerCase();
	const isGeminiProvider =
		providerId.includes('gemini') ||
		providerId === 'google' ||
		providerType.includes('gemini') ||
		providerType.includes('google');
	if (!isGeminiProvider) return false;
	if (hasCooldownManagedProviderFailureSignal(provider)) return false;

	const hasRemoteMedia = messageContainsRemoteMediaUrl(message);
	const lastError = String(
		provider?.lastError || provider?.last_error || provider?.error || ''
	).toLowerCase();
	const lastErrorCode = String(
		provider?.lastErrorCode || provider?.last_error_code || ''
	).toLowerCase();
	const disabledReason = String(
		provider?.disabled_reason || provider?.disabledReason || ''
	).toLowerCase();
	const lastStatus = Number(provider?.lastStatus || provider?.last_status || 0);
	const lastErrorAt = Number(
		provider?.lastErrorAt || provider?.last_error_at || 0
	);
	if (
		lastErrorAt > 0 &&
		Date.now() - lastErrorAt > PROVIDER_AUTH_FAILURE_FAST_SKIP_MS
	) {
		return false;
	}
	const combined = `${lastError} ${lastErrorCode} ${disabledReason}`;

	if (
		hasRemoteMedia &&
		(combined.includes('cannot fetch content from the provided url') ||
			combined.includes('unsupported_remote_media_url') ||
			combined.includes('gemini_unsupported_remote_media_url'))
	) {
		return true;
	}

	if (
		combined.includes(
			'generative language api has not been used in project'
		) ||
		combined.includes('generative language api is disabled') ||
		combined.includes('service_disabled') ||
		combined.includes('accessnotconfigured') ||
		textMentionsHostname(combined, 'generativelanguage.googleapis.com') ||
		combined.includes('gemini_project_auth_failure') ||
		combined.includes('api key not valid') ||
		combined.includes('api key not found') ||
		combined.includes('api key expired') ||
		combined.includes('please renew the api key') ||
		combined.includes('api_key_invalid') ||
		combined.includes('invalid api key') ||
		combined.includes('invalid_argument') ||
		lastStatus === 401 ||
		lastStatus === 403
	) {
		return true;
	}

	if (
		combined.includes('empty streaming response') ||
		combined.includes('returned an empty streaming response')
	) {
		return true;
	}

	if (
		combined.includes('invalid_response_structure') ||
		combined.includes('invalid response structure') ||
		combined.includes('gemini:invalid_response_structure')
	) {
		return true;
	}

	if (
		combined.includes('invalid api key') ||
		combined.includes('incorrect api key provided') ||
		combined.includes('invalid_api_key') ||
		containsOpenAiApiKeyHelpLink(combined)
	) {
		return true;
	}

	return false;
}

function isGeminiCandidateProvider(
	provider: LoadedProviderData | null | undefined
): boolean {
	const providerId = String(provider?.id || '').toLowerCase();
	const providerType = String(
		(provider as any)?.provider || (provider as any)?.type || ''
	).toLowerCase();
	return (
		providerId.includes('gemini') ||
		providerId === 'google' ||
		providerType.includes('gemini') ||
		providerType.includes('google')
	);
}

function maybeExtendGeminiRateLimitWaitBudget(
	currentBudgetMs: number,
	candidateProviders: LoadedProviderData[],
	nextCooldownMs: number | null,
	modelId: string,
	stream: boolean
): number {
	if (
		!Number.isFinite(nextCooldownMs as number) ||
		(nextCooldownMs as number) <= 0 ||
		GEMINI_RATE_LIMIT_TOTAL_WAIT_BUDGET_MS <= currentBudgetMs ||
		candidateProviders.length === 0 ||
		!candidateProviders.every(provider => isGeminiCandidateProvider(provider))
	) {
		return currentBudgetMs;
	}

	const targetBudgetMs = Math.min(
		GEMINI_RATE_LIMIT_TOTAL_WAIT_BUDGET_MS,
		Math.max(currentBudgetMs, Math.ceil(nextCooldownMs as number))
	);
	if (targetBudgetMs <= currentBudgetMs) return currentBudgetMs;

	console.warn(
		`[GeminiWaitBudget] Extending ${stream ? 'streaming ' : ''}wait budget for ${modelId} from ${currentBudgetMs}ms to ${targetBudgetMs}ms to honor Gemini retry-after guidance.`
	);
	return targetBudgetMs;
}

export { messageHandler };
