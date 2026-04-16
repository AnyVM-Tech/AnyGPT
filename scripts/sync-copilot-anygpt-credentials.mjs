#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const keysPath = path.resolve(repoRoot, 'apps/api/keys.json');
const modelsPath = path.resolve(repoRoot, 'apps/api/models.json');
const providersPath = path.resolve(repoRoot, 'apps/api/providers.json');
const defaultWorkspaceSettingsPath = path.resolve(repoRoot, '.vscode/settings.json');
const settingsPath = path.resolve(
  String(process.env.ANYGPT_COPILOT_WORKSPACE_SETTINGS_PATH || defaultWorkspaceSettingsPath).trim() || defaultWorkspaceSettingsPath
);
const ACTIVE_CUSTOM_MODELS_KEY = 'chat.customOAIModels';
const LEGACY_CUSTOM_MODELS_KEY = 'github.copilot.chat.customOAIModels';

const defaultUserSettingsPath = path.resolve(
  process.env.HOME || '',
  '.vscode-server-insiders/data/User/settings.json'
);
const userSettingsPath = path.resolve(
  String(process.env.ANYGPT_COPILOT_USER_SETTINGS_PATH || defaultUserSettingsPath).trim() || defaultUserSettingsPath
);
const syncUserSettings = !/^(0|false|no|off)$/i.test(
  String(process.env.ANYGPT_COPILOT_SYNC_USER_SETTINGS || 'true').trim()
);
const pruneManagedModels = !/^(0|false|no|off)$/i.test(
  String(process.env.ANYGPT_COPILOT_PRUNE_MODELS || 'true').trim()
);
const requireToolCalling = !/^(0|false|no|off)$/i.test(
  String(process.env.ANYGPT_COPILOT_REQUIRE_TOOL_CALLING || 'true').trim()
);

const modelId = String(process.env.ANYGPT_COPILOT_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
const defaultBaseUrl = String(process.env.ANYGPT_BASE_URL || 'http://localhost:3000/native/openai/v1').trim() || 'http://localhost:3000/native/openai/v1';
const maxModels = Math.max(1, Number(process.env.ANYGPT_COPILOT_MAX_MODELS || 1) || 1);
const allModelsMode = /^(1|true|yes|on)$/i.test(String(process.env.ANYGPT_COPILOT_ALL_MODELS || '').trim());
const defaultMaxInputTokens = Math.max(
  1,
  Number(process.env.ANYGPT_COPILOT_DEFAULT_MAX_INPUT_TOKENS || 100000) || 100000
);
const defaultMaxOutputTokens = Math.max(
  1,
  Number(process.env.ANYGPT_COPILOT_DEFAULT_MAX_OUTPUT_TOKENS || 8192) || 8192
);

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function isLikelyTestKey(key) {
  return /test|automated|dummy|example/i.test(key);
}

function normalizeCustomModels(value) {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) {
    const migrated = {};
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.model || item.id || '').trim();
      if (!id) continue;
      migrated[id] = {
        name: String(item.name || `AnyGPT API (${id})`),
        url: String(item.url || item.baseURL || defaultBaseUrl),
        apiKey: String(item.apiKey || ''),
      };
    }
    return migrated;
  }
  return { ...value };
}

function shouldRewriteExistingModelUrl(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const name = String(entry.name || '').toLowerCase();
  const url = String(entry.url || entry.baseURL || '').trim().toLowerCase();
  if (!url) return false;

  // Migrate existing AnyGPT localhost model URLs to the native endpoint.
  if (url === 'http://localhost:3000/v1') return true;
  if (name.startsWith('anygpt api (')) return true;

  return false;
}

function isManagedAnyGptModelEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const name = String(entry.name || '').toLowerCase().trim();
  return name.startsWith('anygpt api (');
}

function canonicalizeNativeFamily(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'openai') return 'openai';
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'deepseek') return 'deepseek';
  if (normalized === 'xai' || normalized === 'x-ai') return 'xai';
  return null;
}

function inferNativeRouteFamily(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const match = parsed.pathname.match(/\/native\/([^/]+)/i);
    return match?.[1] ? canonicalizeNativeFamily(match[1]) : null;
  } catch {
    const match = String(baseUrl || '').match(/\/native\/([^/?#]+)/i);
    return match?.[1] ? canonicalizeNativeFamily(match[1]) : null;
  }
}

function resolveProviderNativeFamily(provider) {
  for (const candidate of [
    provider?.nativeFamily,
    provider?.nativeProtocol,
    provider?.native_family,
    provider?.native_protocol,
  ]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = canonicalizeNativeFamily(candidate);
    if (resolved) return resolved;
  }

  const haystack = `${provider?.id || ''} ${provider?.provider_url || ''}`.toLowerCase();
  if (haystack.includes('openrouter')) return 'openrouter';
  if (haystack.includes('deepseek')) return 'deepseek';
  if (haystack.includes('xai') || haystack.includes('x.ai') || haystack.includes('grok')) return 'xai';
  if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic';
  if (
    haystack.includes('gemini')
    || haystack.includes('google')
    || haystack.includes('generativelanguage')
    || haystack.includes('googleapis')
  ) {
    return 'gemini';
  }
  if (haystack.includes('mock')) return 'openai';
  return 'openai';
}

function buildModelIdVariants(rawModelId) {
  const normalized = String(rawModelId || '').trim().toLowerCase();
  if (!normalized) return [];
  const variants = new Set([normalized]);
  if (normalized.includes('/')) {
    variants.add(normalized.slice(normalized.lastIndexOf('/') + 1));
  }
  return Array.from(variants);
}

function providerSupportsModel(provider, modelId) {
  const variants = new Set(buildModelIdVariants(modelId));
  if (variants.size === 0) return false;
  const providerModelIds = provider?.models && typeof provider.models === 'object'
    ? Object.keys(provider.models)
    : [];
  for (const providerModelId of providerModelIds) {
    for (const variant of buildModelIdVariants(providerModelId)) {
      if (variants.has(variant)) return true;
    }
  }
  return false;
}

function collectCompatibleModelIds(modelsJson, providersJson, baseUrl) {
  const routeFamily = inferNativeRouteFamily(baseUrl);
  if (!routeFamily) return null;

  const activeProviders = Array.isArray(providersJson)
    ? providersJson
        .filter((provider) => provider && typeof provider === 'object')
        .filter((provider) => !provider.disabled)
        .filter((provider) => typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0)
        .filter((provider) => typeof provider.provider_url === 'string' && provider.provider_url.trim().length > 0)
        .filter((provider) => resolveProviderNativeFamily(provider) === routeFamily)
    : [];

  const compatibleIds = new Set();
  for (const entry of toModelList(modelsJson)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim();
    if (!id) continue;
    if (activeProviders.some((provider) => providerSupportsModel(provider, id))) {
      compatibleIds.add(id);
    }
  }

  return compatibleIds;
}

function readSettingsObject(filePath) {
  const settings = readJson(filePath, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Invalid settings JSON at ${filePath}`);
  }
  return settings;
}

function writeSettingsObject(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function pickApiKey(keysObject) {
  const entries = Object.entries(keysObject || {}).filter(([key, meta]) => {
    return typeof key === 'string' && key.length >= 24 && meta && typeof meta === 'object';
  });

  const nonTest = entries.filter(([key]) => !isLikelyTestKey(key));
  const admin = nonTest.find(([, meta]) => String(meta.role || '').toLowerCase() === 'admin');
  if (admin) return { apiKey: admin[0], meta: admin[1] };

  if (nonTest.length > 0) return { apiKey: nonTest[0][0], meta: nonTest[0][1] };
  if (entries.length > 0) return { apiKey: entries[0][0], meta: entries[0][1] };
  return null;
}

function toModelList(modelsJson) {
  if (!modelsJson || typeof modelsJson !== 'object') return [];
  if (Array.isArray(modelsJson)) return modelsJson;
  if (Array.isArray(modelsJson.data)) return modelsJson.data;
  return [];
}

function modelMapById(modelsJson) {
  const map = new Map();
  for (const entry of toModelList(modelsJson)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim();
    if (!id) continue;
    map.set(id, entry);
  }
  return map;
}

function pickModelIds(modelsJson, preferredModel, limit, options = {}) {
  const compatibleModelIds = options.compatibleModelIds instanceof Set
    ? options.compatibleModelIds
    : null;
  let list = toModelList(modelsJson)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const id = String(entry.id || '').trim();
      const providers = Number(entry.providers) || 0;
      const capabilities = Array.isArray(entry.capabilities)
        ? entry.capabilities.map((cap) => String(cap).toLowerCase())
        : [];
      return { id, providers, capabilities };
    })
    .filter((entry) => {
      if (!entry.id) return false;
      // Keep chat-oriented models; skip embedding/image-only variants.
      return entry.capabilities.includes('text');
    });

  if (compatibleModelIds && compatibleModelIds.size > 0) {
    list = list.filter((entry) => compatibleModelIds.has(entry.id));
  }

  const toolCapableList = list.filter((entry) => entry.capabilities.includes('tool_calling'));
  if (options.requireToolCalling !== false && toolCapableList.length > 0) {
    list = toolCapableList;
  }

  list = list
    .sort((a, b) => {
      if (b.providers !== a.providers) return b.providers - a.providers;
      return a.id.localeCompare(b.id);
    });

  const selected = [];

  // Keep a stable, useful default set first when available.
  const priorityOrder = [
    preferredModel,
    'gpt-5.4',
    'gpt-5-mini',
    'gpt-4.1-mini',
    'gpt-4o-mini',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'deepseek-chat',
    'deepseek-reasoner',
    'anthropic/claude-sonnet-4.5',
  ].filter(Boolean);

  for (const id of priorityOrder) {
    if (selected.includes(id)) continue;
    if (list.some((entry) => entry.id === id)) selected.push(id);
  }

  for (const entry of list) {
    if (selected.length >= limit) break;
    if (!selected.includes(entry.id)) selected.push(entry.id);
  }

  return selected.slice(0, limit);
}

function pickAllModelIds(modelsJson, options = {}) {
  const compatibleModelIds = options.compatibleModelIds instanceof Set
    ? options.compatibleModelIds
    : null;
  let list = toModelList(modelsJson)
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const caps = Array.isArray(entry.capabilities)
        ? entry.capabilities.map((cap) => String(cap).toLowerCase())
        : [];
      return caps.includes('text');
    });

  if (compatibleModelIds && compatibleModelIds.size > 0) {
    list = list.filter((entry) => compatibleModelIds.has(String(entry.id || '').trim()));
  }

  if (options.requireToolCalling !== false) {
    const toolCapableList = list.filter((entry) => {
      const caps = Array.isArray(entry.capabilities)
        ? entry.capabilities.map((cap) => String(cap).toLowerCase())
        : [];
      return caps.includes('tool_calling');
    });
    if (toolCapableList.length > 0) {
      list = toolCapableList;
    }
  }

  return list
    .map((entry) => String(entry.id || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

const keysJson = readJson(keysPath, null);
if (!keysJson || typeof keysJson !== 'object') {
  throw new Error(`Could not parse keys file at ${keysPath}`);
}

const selected = pickApiKey(keysJson);
if (!selected) {
  throw new Error('No API keys found in apps/api/keys.json');
}

const modelsJson = readJson(modelsPath, null);
const providersJson = readJson(providersPath, []);
const compatibleModelIds = collectCompatibleModelIds(modelsJson, providersJson, defaultBaseUrl);
const selectedModelIds = allModelsMode
  ? pickAllModelIds(modelsJson, {
      compatibleModelIds,
      requireToolCalling,
    })
  : pickModelIds(modelsJson, modelId, maxModels, {
      compatibleModelIds,
      requireToolCalling,
    });
if (selectedModelIds.length === 0) {
  selectedModelIds.push(modelId);
}
const modelById = modelMapById(modelsJson);

const settings = readSettingsObject(settingsPath);

const customModels = {
  ...normalizeCustomModels(settings[LEGACY_CUSTOM_MODELS_KEY]),
  ...normalizeCustomModels(settings[ACTIVE_CUSTOM_MODELS_KEY]),
};
if (pruneManagedModels) {
  for (const [id, entry] of Object.entries(customModels)) {
    if (isManagedAnyGptModelEntry(entry)) {
      delete customModels[id];
    }
  }
}
for (const [id, entry] of Object.entries(customModels)) {
  if (!shouldRewriteExistingModelUrl(entry)) continue;
  customModels[id] = {
    ...entry,
    url: defaultBaseUrl,
  };
}
for (const id of selectedModelIds) {
  const source = modelById.get(id) || {};
  const caps = Array.isArray(source.capabilities)
    ? source.capabilities.map((cap) => String(cap).toLowerCase())
    : [];
  const toolCalling = caps.includes('tool_calling');
  const vision = caps.includes('image_input') || caps.includes('vision');
  // Copilot BYOK model registration expects finite token limits. If omitted,
  // extension internals can derive NaN limits and drop models from the picker.
  const maxInputTokens = Number.isFinite(Number(source?.context_length))
    ? Number(source.context_length)
    : defaultMaxInputTokens;
  const maxOutputTokens = Number.isFinite(Number(source?.max_output_tokens))
    ? Number(source.max_output_tokens)
    : defaultMaxOutputTokens;

  customModels[id] = {
    name: `AnyGPT API (${id})`,
    url: defaultBaseUrl,
    apiKey: selected.apiKey,
    toolCalling,
    vision,
    maxInputTokens,
    maxOutputTokens,
  };
}

settings[ACTIVE_CUSTOM_MODELS_KEY] = customModels;
settings[LEGACY_CUSTOM_MODELS_KEY] = customModels;

writeSettingsObject(settingsPath, settings);

if (syncUserSettings) {
  const userSettings = readSettingsObject(userSettingsPath);
  userSettings[ACTIVE_CUSTOM_MODELS_KEY] = customModels;
  userSettings[LEGACY_CUSTOM_MODELS_KEY] = customModels;
  writeSettingsObject(userSettingsPath, userSettings);
}

const selectedUser = String(selected.meta.userId || 'unknown');
const selectedRole = String(selected.meta.role || 'unknown');
console.log(
  `[copilot-sync] Updated ${path.relative(repoRoot, settingsPath)} with ${selectedModelIds.length} model(s) using key for user '${selectedUser}' (role: ${selectedRole}).`
);
console.log(`[copilot-sync] Wrote ${ACTIVE_CUSTOM_MODELS_KEY} and ${LEGACY_CUSTOM_MODELS_KEY}.`);
if (syncUserSettings) {
  console.log(`[copilot-sync] Synced user settings at ${userSettingsPath}.`);
} else {
  console.log('[copilot-sync] Skipped user settings sync (ANYGPT_COPILOT_SYNC_USER_SETTINGS=false).');
}
if (allModelsMode) {
  console.log('[copilot-sync] Mode: ALL models from apps/api/models.json');
}
if (compatibleModelIds instanceof Set) {
  console.log(`[copilot-sync] Native route compatible models: ${compatibleModelIds.size}`);
}
if (pruneManagedModels) {
  console.log('[copilot-sync] Pruned existing AnyGPT-managed model entries before writing new ones.');
}
console.log(`[copilot-sync] Base URL: ${defaultBaseUrl}`);
console.log(`[copilot-sync] Primary model: ${selectedModelIds[0]}`);
console.log(`[copilot-sync] Registered models: ${selectedModelIds.join(', ')}`);
console.log('[copilot-sync] Note: API key is stored in plain text in workspace settings for Copilot BYOK usage.');
