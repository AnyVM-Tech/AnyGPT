import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash } from 'crypto';
import type { Provider, Model } from '../providers/interfaces.js';

interface AdminKeyLogEntry {
  key?: string;
  provider?: string;
  tier?: number | null;
}

interface ValidationResult {
  models: string[];
  providerUrl: string;
  streamingCompatible?: boolean;
}

const DEFAULT_SPEED = 50;
const ADMIN_KEYS_PATH = path.resolve('logs/admin-keys.json');
const PROVIDERS_PATH = path.resolve('providers.json');
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

function buildModels(modelIds: string[]): Record<string, Model> {
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
    return acc;
  }, {});
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

  if (!entry.key || !entry.key.trim()) {
    throw new Error('Missing key');
  }

  if (provider === 'gemini') {
    // Quick check via models list to avoid spend
    return validateGemini(entry.key.trim());
  }

  return validateOpenAIStyle(provider as keyof typeof providerDefaults, entry.key.trim());
}

function makeProviderId(provider: string, tier: number | null | undefined, apiKey: string, existingIds: Set<string>): string {
  const tierLabel = typeof tier === 'number' ? `t${tier}` : 't?';
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
  const adminEntries = readJsonFile<AdminKeyLogEntry[]>(ADMIN_KEYS_PATH, []);
  const providers = readJsonFile<Provider[]>(PROVIDERS_PATH, []);

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
  for (const entry of limitedCandidates) {
    try {
      const validation = await validateKey(entry);
      const modelsMap = buildModels(validation.models);

      const existing = existingKeyToProviders.get(entry.key);
      if (existing && existing.length) {
        existing.forEach((providerEntry) => {
          providerEntry.provider_url = validation.providerUrl;
          providerEntry.streamingCompatible = validation.streamingCompatible;
          providerEntry.models = modelsMap;
          console.log(`♻️  refreshed ${providerEntry.id} (${Object.keys(modelsMap).length} models)`);
        });
        refreshedCount += existing.length;
        continue;
      }

      const providerId = makeProviderId(entry.provider, entry.tier, entry.key, existingIds);
      const newProvider: Provider = {
        id: providerId,
        apiKey: entry.key,
        provider_url: validation.providerUrl,
        streamingCompatible: validation.streamingCompatible,
        models: modelsMap,
        disabled: false,
        avg_response_time: null,
        avg_provider_latency: null,
        errors: 0,
        provider_score: null,
      };

      added.push(newProvider);
      existingIds.add(providerId);
      console.log(`✅ ${entry.provider} key ok -> ${providerId} (${Object.keys(modelsMap).length} models)`);
    } catch (error: any) {
      failures.push({ provider: entry.provider, key: entry.key, reason: error?.message || 'Unknown error' });
      console.warn(`❌ ${entry.provider} key failed: ${error?.message || error}`);
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Would add ${added.length} provider(s). No file was changed.`);
    return;
  }

  const updatedProviders = [...providers, ...added];
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(updatedProviders, null, 2), 'utf8');
  console.log(`Saved ${added.length} new provider(s) and refreshed ${refreshedCount} existing provider(s) in ${PROVIDERS_PATH}.`);

  if (failures.length) {
    console.log('Failed keys:');
    failures.forEach((f) => console.log(`- ${f.provider}: ${f.reason}`));
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
