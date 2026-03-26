import type { ModelsFileStructure } from './dataManager.js';
import type { TierData } from './userData.js';

type PublicMetadataValue = string | number | boolean | null;

type PublicPlanSupport = {
  channel?: string | null;
  contact?: string | null;
  response_target?: string | null;
  notes?: string | null;
  url?: string | null;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function normalizeDisplayLimit(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function sanitizeSupport(value: unknown): PublicPlanSupport | null {
  if (!value || typeof value !== 'object') return null;
  const support = value as Record<string, unknown>;
  const sanitized: PublicPlanSupport = {};
  const channel = normalizeString(support.channel);
  const contact = normalizeString(support.contact);
  const responseTarget = normalizeString(support.response_target);
  const notes = normalizeString(support.notes);
  const url = normalizeString(support.url);
  if (channel) sanitized.channel = channel;
  if (contact) sanitized.contact = contact;
  if (responseTarget) sanitized.response_target = responseTarget;
  if (notes) sanitized.notes = notes;
  if (url) sanitized.url = url;
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizePublicMetadata(value: unknown): Record<string, PublicMetadataValue> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sanitized: Record<string, PublicMetadataValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) continue;
    if (
      entry === null
      || typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
    ) {
      sanitized[normalizedKey] = entry as PublicMetadataValue;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPatternRegex(pattern: string): RegExp {
  const escaped = escapeRegex(pattern).replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function collectModelCandidates(modelId: string): string[] {
  const trimmed = String(modelId || '').trim();
  if (!trimmed) return [];
  const candidates = new Set<string>();
  const lowered = trimmed.toLowerCase();
  candidates.add(lowered);

  if (trimmed.includes('/')) {
    const base = trimmed.split('/').pop();
    if (base) candidates.add(base.toLowerCase());
  }

  if (lowered.startsWith('models/')) {
    candidates.add(lowered.slice('models/'.length));
  }

  return [...candidates];
}

function matchesAnyPattern(modelId: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const candidates = collectModelCandidates(modelId);
  return patterns.some((pattern) => {
    const regex = buildPatternRegex(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

function getAllowedPatterns(tier?: TierData | any): string[] {
  return normalizeStringArray((tier as any)?.allowed_models);
}

function getBlockedPatterns(tier?: TierData | any): string[] {
  return normalizeStringArray((tier as any)?.blocked_models);
}

export type PublicModelAccessMode = 'all' | 'allowlist' | 'blocklist' | 'mixed';

export function getPublicModelAccessMode(tier?: TierData | any): PublicModelAccessMode {
  const allowedPatterns = getAllowedPatterns(tier);
  const blockedPatterns = getBlockedPatterns(tier);
  if (allowedPatterns.length > 0 && blockedPatterns.length > 0) return 'mixed';
  if (allowedPatterns.length > 0) return 'allowlist';
  if (blockedPatterns.length > 0) return 'blocklist';
  return 'all';
}

export function isModelAllowedForTier(modelId: string, tier?: TierData | any): boolean {
  const allowedPatterns = getAllowedPatterns(tier);
  const blockedPatterns = getBlockedPatterns(tier);
  if (blockedPatterns.length > 0 && matchesAnyPattern(modelId, blockedPatterns)) {
    return false;
  }
  if (allowedPatterns.length > 0) {
    return matchesAnyPattern(modelId, allowedPatterns);
  }
  return true;
}

export function buildModelAccessError(modelId: string, tier?: TierData | any) {
  const allowedPatterns = getAllowedPatterns(tier);
  const blockedPatterns = getBlockedPatterns(tier);
  return {
    statusCode: 403,
    code: 'model_not_allowed',
    type: 'invalid_request_error',
    message: `The model '${modelId}' is not available on your current plan.`,
    plan_model_access_mode: getPublicModelAccessMode(tier),
    allowed_models: allowedPatterns.length > 0 ? allowedPatterns : null,
    blocked_models: blockedPatterns.length > 0 ? blockedPatterns : null,
  };
}

export function assertModelAllowedForTier(modelId: string, tier?: TierData | any): void {
  if (isModelAllowedForTier(modelId, tier)) return;
  const details = buildModelAccessError(modelId, tier);
  const error = new Error(details.message) as Error & Record<string, unknown>;
  Object.assign(error, details, { modelId });
  throw error;
}

export function filterModelsForTier(modelsData: ModelsFileStructure, tier?: TierData | any): ModelsFileStructure {
  const data = Array.isArray(modelsData?.data) ? modelsData.data : [];
  if (getPublicModelAccessMode(tier) === 'all') {
    return modelsData;
  }
  return {
    ...modelsData,
    data: data.filter((model) => typeof model?.id === 'string' && isModelAllowedForTier(model.id, tier)),
  };
}

export function buildPublicPlanPayload(
  tierId: string,
  tier?: TierData | any,
  options: { visibleModelCount?: number | null } = {}
) {
  const features = normalizeStringArray((tier as any)?.features);
  const allowedPatterns = getAllowedPatterns(tier);
  const blockedPatterns = getBlockedPatterns(tier);
  const visibleModelCount = typeof options.visibleModelCount === 'number' && Number.isFinite(options.visibleModelCount)
    ? Math.max(0, Math.floor(options.visibleModelCount))
    : null;

  return {
    id: tierId,
    name: normalizeString((tier as any)?.display_name) ?? tierId,
    description: normalizeString((tier as any)?.description),
    features: features.length > 0 ? features : null,
    limits: {
      requests_per_second: normalizeDisplayLimit((tier as any)?.rps),
      requests_per_minute: normalizeDisplayLimit((tier as any)?.rpm),
      requests_per_day: normalizeDisplayLimit((tier as any)?.rpd),
      daily_target_requests: normalizeDisplayLimit((tier as any)?.soft_rpd),
      billing_period_target_requests: normalizeDisplayLimit((tier as any)?.billing_period_request_target),
      max_tokens_per_billing_period: normalizeDisplayLimit((tier as any)?.max_tokens),
    },
    model_access: {
      mode: getPublicModelAccessMode(tier),
      allowed_models: allowedPatterns.length > 0 ? allowedPatterns : null,
      blocked_models: blockedPatterns.length > 0 ? blockedPatterns : null,
      visible_model_count: visibleModelCount,
    },
    support: sanitizeSupport((tier as any)?.support),
    metadata: sanitizePublicMetadata((tier as any)?.public_metadata),
  };
}
