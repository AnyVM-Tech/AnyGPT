import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash } from 'crypto';
import type { Provider, Model } from '../providers/interfaces.js';
import { dataManager, LoadedProviders } from '../modules/dataManager.js';
import { upsertProviderById } from '../modules/providerUpsert.js';
import { checkKey } from '../modules/keyChecker.js';
import { redisReadyPromise } from '../modules/db.js';

interface AdminKeyLogEntry {
  key?: string;
  provider?: string;
  tier?: number | null;
}

interface ValidationResult {
  models: string[];
  providerUrl: string;
  streamingCompatible?: boolean;
  tier?: string;
}

const NO_QUOTA_ERROR = 'NO_QUOTA';

const DEFAULT_SPEED = 50;
const ADMIN_KEYS_PATH = path.resolve('logs/admin-keys.json');
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

interface ProbeTestedFile {
  updated_at?: string;
  data?: Record<string, Record<string, string>>;
  capability_skips?: Record<string, Record<string, string>>;
}

interface ProbeProviderStatus {
  quota: Set<string>;
  noAccess: Set<string>;
}

function hashId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
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

function hasOkProbeResult(entry?: Record<string, string>): boolean {
  if (!entry) return false;
  return Object.values(entry).some((value) => typeof value === 'string' && value.toLowerCase().startsWith('ok'));
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
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const providerId = typeof entry?.providerId === 'string' ? entry.providerId : '';
    const reason = typeof entry?.reason === 'string' ? entry.reason.toLowerCase() : '';
    if (!providerId) continue;

    if (entry?.type === 'provider_disabled' || entry?.type === 'key_no_quota' || entry?.type === 'provider_no_quota') {
      if (reason.includes('quota')) status.quota.add(providerId);
      if (reason.includes('no access') || reason.includes('does not have access')) status.noAccess.add(providerId);
      continue;
    }

    if (entry?.type === 'probe_skip' && reason) {
      if (reason.includes('quota')) status.quota.add(providerId);
      if (reason.includes('no access') || reason.includes('does not have access')) status.noAccess.add(providerId);
    }
  }

  return status;
}

function filterModelsWithProbe(
  modelIds: string[],
  probeData: ProbeTestedFile
): { models: string[]; skipped: number } {
  const probeEntries = probeData.data || {};
  if (Object.keys(probeEntries).length === 0) {
    return { models: modelIds, skipped: 0 };
  }
  const filtered: string[] = [];
  let skipped = 0;

  for (const modelId of modelIds) {
    const entry = probeEntries[modelId];
    if (hasOkProbeResult(entry)) {
      filtered.push(modelId);
    } else {
      skipped += 1;
    }
  }

  return { models: filtered, skipped };
}

function buildModels(
  modelIds: string[],
  capabilitySkips?: Record<string, Record<string, string>>
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
    disabled: typeof (existing as any).disabled === 'boolean' ? (existing as any).disabled : (next as any).disabled,
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
  const status = await checkKey(provider, apiKey);
  if (!status.isValid) {
      throw new Error(`Key check failed: ${status.error || 'Invalid key'}`);
  }
  if (status.hasQuota === false) {
      throw new Error(NO_QUOTA_ERROR);
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

  const adminEntries = readJsonFile<AdminKeyLogEntry[]>(ADMIN_KEYS_PATH, []);
  const providers = await dataManager.load<LoadedProviders>('providers');
  if (!Array.isArray(providers)) {
    throw new Error('Invalid providers data format. Expected an array.');
  }
  const probeTested = loadProbeTested();
  const probeProviderStatus = loadProbeProviderStatus();

  const existingKeyToProviders = new Map<string, Provider[]>();
  providers.forEach((p) => {
    if (!p.apiKey) return;
    const list = existingKeyToProviders.get(p.apiKey) || [];
    list.push(p);
    existingKeyToProviders.set(p.apiKey, list);
  });
  const existingIds = new Set<string>(providers.map((p) => p.id));

  const seenKeys = new Set<string>();
  const candidates = adminEntries
    .filter((entry) => entry && typeof entry.key === 'string' && typeof entry.provider === 'string')
    .map((entry) => ({
      key: entry.key!.trim(),
      provider: entry.provider!.toLowerCase(),
      tier: typeof entry.tier === 'number' ? entry.tier : null,
    }))
    .filter((entry) => {
      if (!entry.key || !entry.provider) return false;
      if (providerFilter && !providerFilter.includes(entry.provider)) return false;
      if (seenKeys.has(entry.key)) return false;
      seenKeys.add(entry.key);
      return true;
    });

  const limitedCandidates = typeof limit === 'number' && Number.isFinite(limit)
    ? candidates.slice(0, limit)
    : candidates;

  const added: Provider[] = [];
  const failures: { provider: string; key: string; reason: string }[] = [];
  const skippedExisting = adminEntries.length - candidates.length;

  console.log(`Found ${adminEntries.length} logged keys. ${skippedExisting} skipped (existing, duplicates, or filtered). Processing ${limitedCandidates.length} candidate(s).`);

  let refreshedCount = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < limitedCandidates.length; i += BATCH_SIZE) {
      const batch = limitedCandidates.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(limitedCandidates.length / BATCH_SIZE)}...`);

      await Promise.all(batch.map(async (entry) => {
        try {
          const validation = await validateKey(entry);
          const probeFilter = filterModelsWithProbe(validation.models, probeTested);
          if (probeFilter.skipped > 0) {
            console.log(`ℹ️  ${entry.provider} key ${entry.key.slice(0, 6)}...: skipped ${probeFilter.skipped} model(s) without probe ok`);
          }
          if (probeFilter.models.length === 0) {
            throw new Error('No probe-ok models to import');
          }
          const modelsMap = buildModels(probeFilter.models, probeTested.capability_skips);

          const existing = existingKeyToProviders.get(entry.key);
          if (existing && existing.length) {
            existing.forEach((providerEntry) => {
              providerEntry.provider_url = validation.providerUrl;
              providerEntry.streamingCompatible = validation.streamingCompatible;
              providerEntry.models = mergeModelMaps(providerEntry.models, modelsMap);
              if (probeProviderStatus.quota.has(providerEntry.id) || probeProviderStatus.noAccess.has(providerEntry.id)) {
                providerEntry.disabled = true;
              }
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
            disabled: probeProviderStatus.quota.has(providerId) || probeProviderStatus.noAccess.has(providerId),
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
          const isNoQuota = message.includes(NO_QUOTA_ERROR);
          failures.push({ provider: entry.provider, key: entry.key, reason: isNoQuota ? 'no quota' : message });
          console.warn(`❌ ${entry.provider} key failed: ${isNoQuota ? 'no quota' : message}`);

          const existing = existingKeyToProviders.get(entry.key);
          if (existing) {
            existing.forEach((p) => {
              const idx = providers.findIndex((prov) => prov.id === p.id);
              if (idx === -1) return;
              if (isNoQuota) {
                providers[idx].disabled = true;
                console.log(`⏸️  Disabled no-quota provider ${p.id}.`);
              } else {
                providers.splice(idx, 1);
                console.log(`🗑️  Removed invalid/dead provider ${p.id} from list.`);
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

  await dataManager.save<LoadedProviders>('providers', providers);
  console.log(`Saved ${added.length} new provider(s) and refreshed ${refreshedCount} existing provider(s).`);

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
