import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash } from 'crypto';
import { hashToken } from '../modules/redaction.js';
import type { Provider, Model } from '../providers/interfaces.js';
import { dataManager, LoadedProviders } from '../modules/dataManager.js';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';
import { upsertProviderById } from '../modules/providerUpsert.js';
import { checkKeyHealth } from '../modules/keyChecker.js';
import { redisReadyPromise } from '../modules/db.js';

interface AdminKeyLogEntry {
  key?: string;
  provider?: string;
  tier?: number | null;
}

interface CandidateKeyEntry {
  key: string;
  provider: string;
  tier: number | null;
  source: 'admin-log' | 'existing-provider';
}

interface ValidationResult {
  models: string[];
  providerUrl: string;
  streamingCompatible?: boolean;
  tier?: string;
}

type TargetKind = 'image' | 'video';
type ProviderFamily = 'openai' | 'xai' | 'google' | '';

interface PricingFile {
  models?: Record<string, { per_image?: number; per_request?: number }>;
}

const NO_QUOTA_ERROR = 'NO_QUOTA';
type ValidationFailureCode = 'NO_QUOTA' | 'INVALID_KEY' | 'INDETERMINATE_HEALTH';

type ValidationFailure = Error & {
  code?: ValidationFailureCode;
};

function createValidationFailure(code: ValidationFailureCode, message: string): ValidationFailure {
  const error = new Error(message) as ValidationFailure;
  error.code = code;
  return error;
}

const DEFAULT_SPEED = 50;
const ADMIN_KEYS_PATH = path.resolve('logs/admin-keys.jsonl');
const PROBE_TESTED_PATH = path.resolve('logs/probe-tested.json');
const PROBE_LOG_PATH = path.resolve('logs/probe-errors.jsonl');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const providersArg = args.find((arg) => arg.startsWith('--providers='));
const providerFilter = providersArg
  ? providersArg
      .replace('--providers=', '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  : null;

const providerDefaults: Record<string, { chatUrl: string; modelsUrl: string; streamingCompatible?: boolean }> = {
  openai: {
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    streamingCompatible: true,
  },
  openrouter: {
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    streamingCompatible: true,
  },
  deepseek: {
    chatUrl: 'https://api.deepseek.com/v1/chat/completions',
    modelsUrl: 'https://api.deepseek.com/v1/models',
    streamingCompatible: true,
  },
  xai: {
    chatUrl: 'https://api.x.ai/v1/chat/completions',
    modelsUrl: 'https://api.x.ai/v1/models',
    streamingCompatible: true,
  },
  gemini: {
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    streamingCompatible: true,
  },
};

let pricedMediaModelsCache: string[] | null = null;

function getTargetKind(modelId: string): TargetKind | null {
  const lower = String(modelId || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('grok-imagine-video') || lower.includes('imagine-video') || lower.startsWith('sora') || lower.startsWith('veo-')) {
    return 'video';
  }
  if (
    lower.startsWith('dall-e')
    || lower.startsWith('gpt-image')
    || lower.includes('gpt-image')
    || lower.includes('chatgpt-image')
    || lower.includes('image-gen')
    || lower.includes('imagegen')
    || lower.startsWith('imagen')
    || lower.includes('nano-banana')
    || lower.includes('grok-imagine')
    || lower.includes('grok-2-image')
  ) {
    return 'image';
  }
  return null;
}

function getModelFamily(modelId: string): ProviderFamily {
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('imagen') || lower.includes('nano-banana') || lower.startsWith('veo-')) return 'google';
  if (lower.includes('grok-')) return 'xai';
  if (lower.includes('grok-imagine')) return 'xai';
  if (lower.startsWith('dall-e') || lower.startsWith('gpt-image') || lower.includes('chatgpt-image') || lower.startsWith('sora')) return 'openai';
  return '';
}

function getProviderFamily(provider: string): ProviderFamily {
  const lower = String(provider || '').toLowerCase();
  if (lower === 'gemini' || lower === 'google') return 'google';
  if (lower === 'openai') return 'openai';
  if (lower === 'xai') return 'xai';
  return '';
}

function resolveExistingProviderFamily(providerEntry: Pick<Provider, 'id' | 'provider_url'>): string | null {
  const id = String(providerEntry.id || '').toLowerCase();
  const url = String(providerEntry.provider_url || '').toLowerCase();
  if (id.includes('openai') || url.includes('api.openai.com')) return 'openai';
  if (id.includes('openrouter') || url.includes('openrouter.ai')) return 'openrouter';
  if (id.includes('deepseek') || url.includes('api.deepseek.com')) return 'deepseek';
  if (id.includes('xai') || id.includes('x-ai') || url.includes('api.x.ai')) return 'xai';
  if (id.includes('gemini') || id === 'google' || url.includes('generativelanguage.googleapis.com')) return 'gemini';
  return null;
}

function loadPricedMediaModels(): string[] {
  if (pricedMediaModelsCache) return pricedMediaModelsCache;
  try {
    const raw = fs.readFileSync(path.resolve('pricing.json'), 'utf8');
    const parsed = JSON.parse(raw) as PricingFile;
    pricedMediaModelsCache = Object.keys(parsed.models || {}).filter((modelId) => Boolean(getTargetKind(modelId)));
    return pricedMediaModelsCache;
  } catch {
    pricedMediaModelsCache = [];
    return pricedMediaModelsCache;
  }
}

function selectPricedMediaModelsForProvider(modelIds: string[], provider: string): string[] {
  const family = getProviderFamily(provider);
  if (!family) return [];
  const listed = new Set(modelIds);
  return loadPricedMediaModels().filter((modelId) => getModelFamily(modelId) === family && listed.has(modelId));
}

interface ProbeTestedFile {
  updated_at?: string;
  data?: Record<string, Record<string, string>>;
  capability_skips?: Record<string, Record<string, string>>;
}

interface ProbeProviderStatus {
  quota: Set<string>;
  noAccess: Set<string>;
}

type ProbeProviderAvailability = 'quota' | 'noAccess' | 'ready';

function shouldPersistQuotaDisable(providerName: string | null | undefined): boolean {
  const lower = String(providerName || '').toLowerCase();
  return lower !== 'gemini' && lower !== 'google';
}

function classifyProbeProviderAvailability(entry: any): ProbeProviderAvailability | null {
  const reason = typeof entry?.reason === 'string' ? entry.reason.toLowerCase() : '';
  const type = typeof entry?.type === 'string' ? entry.type : '';

  if (type === 'provider_reenabled') return 'ready';
  if (type === 'key_invalid') return 'noAccess';

  if (type === 'provider_disabled' || type === 'key_no_quota' || type === 'provider_no_quota') {
    if (reason.includes('quota')) return 'quota';
    if (
      reason.includes('no access') ||
      reason.includes('does not have access') ||
      reason.includes('not valid') ||
      reason.includes('not found') ||
      reason.includes('expired') ||
      reason.includes('suspended') ||
      reason.includes('has not been used in project') ||
      reason.includes('permission denied')
    ) {
      return 'noAccess';
    }
  }

  return null;
}

function shouldDisableProviderFromProbeStatus(
  providerId: string,
  providerName: string | null | undefined,
  probeProviderStatus: ProbeProviderStatus
): boolean {
  if (probeProviderStatus.noAccess.has(providerId)) return true;
  return shouldPersistQuotaDisable(providerName) && probeProviderStatus.quota.has(providerId);
}

function hashId(key: string): string {
  if (!key) return 'unknown';
  return hashToken(key).slice(0, 12);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.warn(`Warning: could not read ${filePath}: ${error.message}`);
    }
    return fallback;
  }
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const entries: T[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed line
      }
    }
    return entries;
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.warn(`Warning: could not read ${filePath}: ${error.message}`);
    }
    return [];
  }
}

function hasOkProbeResult(entry?: Record<string, string>): boolean {
  if (!entry) return false;
  return Object.values(entry).some((value) => typeof value === 'string' && value.toLowerCase().startsWith('ok'));
}

function isFineTunedModel(modelId: string): boolean {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  return id.startsWith('ft:') || id.includes(':ft-') || id.includes(':ft:');
}

function loadProbeTested(): ProbeTestedFile {
  if (!fs.existsSync(PROBE_TESTED_PATH)) return { data: {}, capability_skips: {} };
  try {
    const raw = fs.readFileSync(PROBE_TESTED_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ProbeTestedFile;
    if (!parsed || typeof parsed !== 'object') return { data: {}, capability_skips: {} };
    if (!parsed.data || typeof parsed.data !== 'object') parsed.data = {};
    if (!parsed.capability_skips || typeof parsed.capability_skips !== 'object') parsed.capability_skips = {};
    return parsed;
  } catch (err: any) {
    console.warn(`Warning: could not read ${PROBE_TESTED_PATH}: ${err?.message || err}`);
    return { data: {}, capability_skips: {} };
  }
}

function loadProbeProviderStatus(): ProbeProviderStatus {
  const status: ProbeProviderStatus = { quota: new Set(), noAccess: new Set() };
  if (!fs.existsSync(PROBE_LOG_PATH)) return status;

  let raw = '';
  try {
    raw = fs.readFileSync(PROBE_LOG_PATH, 'utf8');
  } catch (err: any) {
    console.warn(`Warning: could not read ${PROBE_LOG_PATH}: ${err?.message || err}`);
    return status;
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const currentAvailability = new Map<string, ProbeProviderAvailability>();
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const providerId = typeof entry?.providerId === 'string' ? entry.providerId : '';
    if (!providerId) continue;
    const availability = classifyProbeProviderAvailability(entry);
    if (!availability) continue;
    currentAvailability.set(providerId, availability);
  }

  for (const [providerId, availability] of currentAvailability.entries()) {
    if (availability === 'quota') status.quota.add(providerId);
    if (availability === 'noAccess') status.noAccess.add(providerId);
  }

  return status;
}

function partitionModelsByProbeStatus(
  modelIds: string[],
  probeData: ProbeTestedFile,
  readyModelIds: Set<string>,
  pendingModelIds: Set<string>
): { readyModels: string[]; pendingModels: string[]; skippedFineTunes: number } {
  const probeEntries = probeData.data || {};
  const ready: string[] = [];
  const pending: string[] = [];
  let skippedFineTunes = 0;
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    if (isFineTunedModel(modelId)) {
      skippedFineTunes += 1;
      continue;
    }
    const entry = probeEntries[modelId];
    if (hasOkProbeResult(entry) || readyModelIds.has(modelId)) {
      ready.push(modelId);
      pendingModelIds.delete(modelId);
      readyModelIds.add(modelId);
    } else {
      pending.push(modelId);
      if (!readyModelIds.has(modelId)) {
        pendingModelIds.add(modelId);
      }
    }
  }

  return { readyModels: ready, pendingModels: pending, skippedFineTunes };
}

function buildModels(
  modelIds: string[],
  capabilitySkips?: Record<string, Record<string, string>>,
  pendingProbeModelIds: Set<string> = new Set()
): Record<string, Model> {
  const uniqueIds = Array.from(new Set(modelIds));
  return uniqueIds.reduce<Record<string, Model>>((acc, id) => {
    acc[id] = {
      id,
      token_generation_speed: DEFAULT_SPEED,
      response_times: [],
      errors: 0,
      consecutive_errors: 0,
      avg_response_time: null,
      avg_provider_latency: null,
      avg_token_speed: null,
    };
    if (pendingProbeModelIds.has(id)) {
      (acc[id] as Model).disabled = true;
      (acc[id] as Model).pending_probe = true;
    }
    const skips = capabilitySkips?.[id];
    if (skips && Object.keys(skips).length) {
      (acc[id] as Model).capability_skips = { ...skips };
    }
    return acc;
  }, {});
}

function mergeModelStats(existing: Model | undefined, next: Model): Model {
  if (!existing) return next;
  const mergedSkips = {
    ...(existing.capability_skips || {}),
    ...(next.capability_skips || {}),
  };
  const existingPendingProbe = typeof (existing as any).pending_probe === 'boolean'
    ? Boolean((existing as any).pending_probe)
    : undefined;
  const nextPendingProbe = typeof (next as any).pending_probe === 'boolean'
    ? Boolean((next as any).pending_probe)
    : undefined;
  let disabled = typeof (existing as any).disabled === 'boolean'
    ? (existing as any).disabled
    : (next as any).disabled;

  if (nextPendingProbe === true) {
    disabled = true;
  } else if (existingPendingProbe && nextPendingProbe === false) {
    disabled = false;
  }

  return {
    ...next,
    token_generation_speed: typeof existing.token_generation_speed === 'number' && existing.token_generation_speed > 0
      ? existing.token_generation_speed
      : next.token_generation_speed,
    response_times: Array.isArray(existing.response_times) && existing.response_times.length > 0
      ? existing.response_times
      : next.response_times,
    errors: typeof existing.errors === 'number' ? existing.errors : next.errors,
    consecutive_errors: typeof existing.consecutive_errors === 'number' ? existing.consecutive_errors : next.consecutive_errors,
    avg_response_time: typeof existing.avg_response_time === 'number' ? existing.avg_response_time : next.avg_response_time,
    avg_provider_latency: typeof existing.avg_provider_latency === 'number' ? existing.avg_provider_latency : next.avg_provider_latency,
    avg_token_speed: typeof existing.avg_token_speed === 'number' ? existing.avg_token_speed : next.avg_token_speed,
    capability_skips: Object.keys(mergedSkips).length ? mergedSkips : undefined,
    disabled,
    pending_probe: typeof nextPendingProbe === 'boolean' ? nextPendingProbe : existingPendingProbe,
  };
}

function mergeModelMaps(existing: Record<string, Model> | undefined, next: Record<string, Model>): Record<string, Model> {
  const merged: Record<string, Model> = {};
  for (const [modelId, modelData] of Object.entries(next)) {
    merged[modelId] = mergeModelStats(existing?.[modelId], modelData);
  }
  return merged;
}

async function validateOpenAIStyle(provider: keyof typeof providerDefaults, apiKey: string): Promise<ValidationResult> {
  const meta = providerDefaults[provider];
  const res = await axios.get(meta.modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 8000,
  });
  const models = Array.isArray(res.data?.data)
    ? res.data.data
        .map((m: any) => m?.id)
        .filter((id: unknown): id is string => typeof id === 'string')
    : [];
  if (!models.length) {
    throw new Error('No models returned for this key');
  }
  return {
    models,
    providerUrl: meta.chatUrl,
    streamingCompatible: meta.streamingCompatible,
  };
}

async function validateGemini(apiKey: string): Promise<ValidationResult> {
  const meta = providerDefaults.gemini;
  const res = await axios.get(meta.modelsUrl, {
    params: { key: apiKey },
    timeout: 8000,
  });

  const list = Array.isArray(res.data?.models)
    ? res.data.models
    : Array.isArray(res.data?.data)
    ? res.data.data
    : [];

  const ids = list
    .map((m: any) => {
      if (typeof m?.name === 'string') return m.name.split('/').pop();
      if (typeof m?.id === 'string') return m.id;
      return null;
    })
    .filter((id: any): id is string => Boolean(id));

  if (!ids.length) {
    throw new Error('No models returned for this key');
  }

  return {
    models: ids,
    providerUrl: meta.chatUrl,
    streamingCompatible: meta.streamingCompatible,
  };
}

async function validateKey(entry: AdminKeyLogEntry): Promise<ValidationResult> {
  const provider = (entry.provider || '').toLowerCase();
  if (!(provider in providerDefaults)) {
    throw new Error(`Unsupported provider: ${provider || 'unknown'}`);
  }

  const apiKey = entry.key ? entry.key.trim() : '';
  if (!apiKey) {
    throw new Error('Missing key');
  }

  // 1. Run enhanced validation (Quota, Tier, Balance check)
  const status = await checkKeyHealth(provider, apiKey);
  if (status.health === 'indeterminate') {
    throw createValidationFailure('INDETERMINATE_HEALTH', status.error || 'Key health check was indeterminate');
  }
  if (status.health === 'invalid') {
    throw createValidationFailure('INVALID_KEY', `Key check failed: ${status.error || 'Invalid key'}`);
  }
  const allowGeminiQuotaLimitedRefresh = provider === 'gemini'
    && status.isValid
    && Array.isArray(status.models)
    && status.models.length > 0;
  if (status.health === 'no-quota' && !allowGeminiQuotaLimitedRefresh) {
    throw createValidationFailure(NO_QUOTA_ERROR, NO_QUOTA_ERROR);
  }

  // 2. Fetch models if not returned by checker
  let models = status.models || [];
  if (models.length === 0) {
      // Fallback to basic listing
      if (provider === 'gemini') {
        const v = await validateGemini(apiKey);
        models = v.models;
      } else {
        const v = await validateOpenAIStyle(provider as keyof typeof providerDefaults, apiKey);
        models = v.models;
      }
  }

  const meta = providerDefaults[provider];
  return {
    models,
    providerUrl: meta.chatUrl,
    streamingCompatible: meta.streamingCompatible,
    tier: status.tier ? String(status.tier) : undefined
  };
}

function makeProviderId(provider: string, tier: number | string | null | undefined, apiKey: string, existingIds: Set<string>): string {
  let tierLabel = 't?';
  if (typeof tier === 'number') tierLabel = `t${tier}`;
  else if (typeof tier === 'string') {
      // Normalize tier string from checker
      if (tier.includes('Tier')) tierLabel = `t${tier.replace('Tier', '').trim()}`;
      else tierLabel = `t-${tier.replace(/\s+/g, '-')}`;
  }
  
  const base = `${provider}-${tierLabel}-${hashId(apiKey)}`;
  if (!existingIds.has(base)) return base;
  let suffix = 1;
  let candidate = `${base}-${suffix}`;
  while (existingIds.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

async function main() {
  if (redisReadyPromise) {
    try {
      console.log('Waiting for Redis connection...');
      await redisReadyPromise;
      console.log('Redis connected. DataManager will use configured preference.');
    } catch (err) {
      console.warn('Redis connection failed, proceeding with fallback logic:', err);
    }
  }

  const adminEntries = readJsonLines<AdminKeyLogEntry>(ADMIN_KEYS_PATH);
  const providers = await dataManager.load<LoadedProviders>('providers');
  if (!Array.isArray(providers)) {
    throw new Error('Invalid providers data format. Expected an array.');
  }
  const probeTested = loadProbeTested();
  const probeProviderStatus = loadProbeProviderStatus();

  const existingKeyToProviders = new Map<string, Provider[]>();
  const readyImportedModelIds = new Set<string>();
  const pendingImportedModelIds = new Set<string>();
  providers.forEach((p) => {
    if (!p.apiKey) return;
    const list = existingKeyToProviders.get(p.apiKey) || [];
    list.push(p);
    existingKeyToProviders.set(p.apiKey, list);
    for (const [modelId, modelData] of Object.entries(p.models || {})) {
      if ((modelData as any)?.pending_probe) pendingImportedModelIds.add(modelId);
      else readyImportedModelIds.add(modelId);
    }
  });
  const existingIds = new Set<string>(providers.map((p) => p.id));

  const candidatesByIdentity = new Map<string, CandidateKeyEntry>();
  let skippedAdminEntries = 0;

  for (const entry of adminEntries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.provider !== 'string') {
      skippedAdminEntries += 1;
      continue;
    }
    const key = entry.key.trim();
    const provider = entry.provider.trim().toLowerCase();
    if (!key || !provider) {
      skippedAdminEntries += 1;
      continue;
    }
    if (providerFilter && !providerFilter.includes(provider)) {
      skippedAdminEntries += 1;
      continue;
    }
    const identity = `${provider}:${key}`;
    if (candidatesByIdentity.has(identity)) {
      skippedAdminEntries += 1;
      continue;
    }
    candidatesByIdentity.set(identity, {
      key,
      provider,
      tier: typeof entry.tier === 'number' ? entry.tier : null,
      source: 'admin-log',
    });
  }

  let discoveredExistingCandidates = 0;
  for (const [apiKey, providerEntries] of existingKeyToProviders.entries()) {
    const firstProvider = providerEntries[0];
    const provider = firstProvider ? resolveExistingProviderFamily(firstProvider) : null;
    if (!provider) continue;
    if (providerFilter && !providerFilter.includes(provider)) continue;
    const identity = `${provider}:${apiKey}`;
    if (candidatesByIdentity.has(identity)) continue;
    candidatesByIdentity.set(identity, {
      key: apiKey,
      provider,
      tier: null,
      source: 'existing-provider',
    });
    discoveredExistingCandidates += 1;
  }

  const candidates = Array.from(candidatesByIdentity.values());

  const limitedCandidates = typeof limit === 'number' && Number.isFinite(limit)
    ? candidates.slice(0, limit)
    : candidates;

  const added: Provider[] = [];
  const failures: { provider: string; key: string; reason: string }[] = [];
  const skippedExisting = skippedAdminEntries;

  console.log(`Found ${adminEntries.length} logged keys. ${skippedExisting} admin entries skipped (invalid, duplicate, or filtered). Added ${discoveredExistingCandidates} refresh candidate(s) from existing providers. Processing ${limitedCandidates.length} candidate(s).`);

  let refreshedCount = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < limitedCandidates.length; i += BATCH_SIZE) {
      const batch = limitedCandidates.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(limitedCandidates.length / BATCH_SIZE)}...`);

      await Promise.all(batch.map(async (entry) => {
        try {
          const validation = await validateKey(entry);
          const probePartition = partitionModelsByProbeStatus(
            validation.models,
            probeTested,
            readyImportedModelIds,
            pendingImportedModelIds
          );
          if (probePartition.pendingModels.length > 0) {
            console.log(`ℹ️  ${entry.provider} key ${entry.key.slice(0, 6)}...: queued ${probePartition.pendingModels.length} new model(s) for probing`);
          }
          if (probePartition.skippedFineTunes > 0) {
            console.log(`ℹ️  ${entry.provider} key ${entry.key.slice(0, 6)}...: skipped ${probePartition.skippedFineTunes} private fine-tune model(s)`);
          }
          const importModels = Array.from(new Set([...probePartition.readyModels, ...probePartition.pendingModels]));
          if (importModels.length === 0) {
            throw new Error('No importable models after filtering');
          }
          const modelsMap = buildModels(importModels, probeTested.capability_skips, new Set(probePartition.pendingModels));
          probePartition.readyModels
            .filter((modelId) => pendingImportedModelIds.has(modelId))
            .forEach((modelId) => {
              if (!modelsMap[modelId]) return;
              modelsMap[modelId].pending_probe = false;
              modelsMap[modelId].disabled = false;
            });

          probePartition.readyModels.forEach((modelId) => {
            readyImportedModelIds.add(modelId);
            pendingImportedModelIds.delete(modelId);
          });
          probePartition.pendingModels.forEach((modelId) => {
            if (!readyImportedModelIds.has(modelId)) {
              pendingImportedModelIds.add(modelId);
            }
          });

          const existing = existingKeyToProviders.get(entry.key);
          if (existing && existing.length) {
            existing.forEach((providerEntry) => {
              providerEntry.provider_url = validation.providerUrl;
              providerEntry.streamingCompatible = validation.streamingCompatible;
              providerEntry.models = mergeModelMaps(providerEntry.models, modelsMap);
              const providerFamily = resolveExistingProviderFamily(providerEntry) || entry.provider;
              providerEntry.disabled = shouldDisableProviderFromProbeStatus(
                providerEntry.id,
                providerFamily,
                probeProviderStatus
              );
              console.log(`♻️  refreshed ${providerEntry.id} (${Object.keys(modelsMap).length} models)`);
            });
            refreshedCount += existing.length;
            return;
          }

          const tierArg = validation.tier || entry.tier;
          const providerId = makeProviderId(entry.provider, tierArg, entry.key, existingIds);
          const newProvider: Provider = {
            id: providerId,
            apiKey: entry.key,
            provider_url: validation.providerUrl,
            streamingCompatible: validation.streamingCompatible,
            models: modelsMap,
            disabled: shouldDisableProviderFromProbeStatus(providerId, entry.provider, probeProviderStatus),
            avg_response_time: null,
            avg_provider_latency: null,
            errors: 0,
            provider_score: null,
          };

          const upserted = upsertProviderById(providers as Provider[], newProvider);
          if (upserted.action === 'added') {
            added.push(newProvider);
          }
          existingIds.add(providerId);
          console.log(`✅ ${entry.provider} key ok -> ${providerId} (${Object.keys(modelsMap).length} models)`);
        } catch (error: any) {
          const message = error?.message || 'Unknown error';
          const failureCode = String(error?.code || '');
          const isNoQuota = failureCode === NO_QUOTA_ERROR || message.includes(NO_QUOTA_ERROR);
          const isInvalidKey = failureCode === 'INVALID_KEY';
          const isIndeterminate = failureCode === 'INDETERMINATE_HEALTH' || (!isNoQuota && !isInvalidKey);
          const failureReason = isNoQuota
            ? 'no quota'
            : isInvalidKey
            ? message
            : `indeterminate health check: ${message}`;
          failures.push({ provider: entry.provider, key: entry.key, reason: failureReason });
          console.warn(`❌ ${entry.provider} key failed: ${failureReason}`);

          const existing = existingKeyToProviders.get(entry.key);
          if (existing) {
            existing.forEach((p) => {
              const idx = providers.findIndex((prov) => prov.id === p.id);
              if (idx === -1) return;
              if (isNoQuota) {
                if (shouldPersistQuotaDisable(entry.provider)) {
                  providers[idx].disabled = true;
                  console.log(`⏸️  Disabled no-quota provider ${p.id}.`);
                } else {
                  providers[idx].disabled = false;
                  console.log(`↺ Retained ${p.id}; Gemini quota exhaustion is treated as temporary.`);
                }
              } else if (isInvalidKey) {
                providers[idx].disabled = true;
                console.log(`⏸️  Disabled invalid provider ${p.id}.`);
              } else if (isIndeterminate) {
                console.log(`⚠️  Retained existing provider ${p.id}; validation was indeterminate.`);
              }
            });
          }
        }
      }));
  }

  if (dryRun) {
    console.log(`[dry-run] Would add ${added.length} provider(s). No file was changed.`);
    return;
  }

  if (added.length === 0 && refreshedCount === 0 && failures.length === 0) {
    console.log('No provider changes detected. Skipping providers save.');
    return;
  }

  await dataManager.save<LoadedProviders>('providers', providers);
  console.log(`Saved ${added.length} new provider(s) and refreshed ${refreshedCount} existing provider(s).`);

  const previousDisableSync = process.env.DISABLE_MODEL_SYNC;
  process.env.DISABLE_MODEL_SYNC = 'false';
  try {
    await refreshProviderCountsInModelsFile();
    console.log('Synchronized models.json after provider refresh.');
  } finally {
    if (typeof previousDisableSync === 'string') process.env.DISABLE_MODEL_SYNC = previousDisableSync;
    else delete process.env.DISABLE_MODEL_SYNC;
  }

  if (failures.length) {
    console.log('Failed keys:');
    failures.forEach((f) => console.log(`- ${f.provider}: ${f.reason}`));

    const failLogPath = path.resolve('logs/key-transfer-failures.json');
    try {
      fs.writeFileSync(failLogPath, JSON.stringify(failures, null, 2));
      console.log(`Detailed failure log written to ${failLogPath}`);
    } catch (err) {
      console.error('Failed to write failure log:', err);
    }
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
