import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type ProbeData = Record<string, Record<string, string>>;
type ProbeFile = {
  updated_at?: string;
  data?: ProbeData;
  capability_skips?: Record<string, Record<string, string>>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const MODELS_PATH = path.join(projectRoot, 'models.json');
const PROBE_PATH = path.join(projectRoot, 'logs', 'probe-tested.json');
const CAPS_CACHE_PATH = path.join(projectRoot, 'logs', 'model-capabilities.json');

const CAP_ORDER = ['text', 'image_input', 'image_output', 'audio_input', 'audio_output', 'tool_calling'] as const;
type Capability = typeof CAP_ORDER[number];

const PROBE_FAULT_KEYWORDS = [
  'rate limit',
  'rate-limit',
  'quota',
  'timeout',
  'timed out',
  'overload',
  'overloaded',
  'temporar',
  'unavailable',
  'connection',
  'econn',
  'socket',
  'bad gateway',
  'gateway',
  '502',
  '503',
  '504',
  '429',
  'server error',
  'internal server error',
  'network',
  'upstream',
  'refused',
  'reset',
];

const NON_FAULT_SKIP_KEYWORDS = [
  'unsupported',
  'does not support',
  'not supported',
  'invalid tool_choice',
  'completions-only',
  'private fine-tune',
  'fine-tune',
  'realtime',
  'xai image',
  'xai video',
  'embedding',
  'known capabilities',
  'org-specific',
];

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isProbeFault(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith('retry:')) return true;
  if (lower.startsWith('fail:')) {
    if (NON_FAULT_SKIP_KEYWORDS.some((kw) => lower.includes(kw))) return false;
    return PROBE_FAULT_KEYWORDS.some((kw) => lower.includes(kw));
  }
  if (lower.startsWith('skip:')) {
    if (NON_FAULT_SKIP_KEYWORDS.some((kw) => lower.includes(kw))) return false;
    return PROBE_FAULT_KEYWORDS.some((kw) => lower.includes(kw));
  }
  return false;
}

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const modelsFile = loadJson<{ data?: any[] }>(MODELS_PATH, { data: [] });
const probeFile = loadJson<ProbeFile>(PROBE_PATH, { data: {} });
const capabilitiesCache = loadJson<Record<string, string[]>>(CAPS_CACHE_PATH, {});

const probeData: ProbeData = probeFile.data ?? {};

let probeChanged = false;
let modelsChanged = false;
let capsCacheChanged = false;
let removedProbeEntries = 0;
let updatedModels = 0;

for (const [modelId, results] of Object.entries(probeData)) {
  const updatedResults: Record<string, string> = { ...results };
  for (const [key, value] of Object.entries(results)) {
    if (typeof value !== 'string') continue;
    if (key === '_status') {
      if (isProbeFault(value)) {
        delete updatedResults[key];
        removedProbeEntries += 1;
        probeChanged = true;
      }
      continue;
    }
    if (isProbeFault(value)) {
      delete updatedResults[key];
      removedProbeEntries += 1;
      probeChanged = true;
    }
  }
  probeData[modelId] = updatedResults;

  const okCaps = CAP_ORDER.filter((cap) => {
    const value = updatedResults[cap];
    return typeof value === 'string' && value.toLowerCase().startsWith('ok');
  });

  if (okCaps.length > 0) {
    const existingCache = capabilitiesCache[modelId] ?? [];
    const merged = CAP_ORDER.filter((cap) => new Set([...existingCache, ...okCaps]).has(cap));
    if (!arraysEqual(existingCache, merged)) {
      capabilitiesCache[modelId] = merged;
      capsCacheChanged = true;
    }
  }
}

if (Array.isArray(modelsFile.data)) {
  for (const model of modelsFile.data) {
    if (!model || typeof model.id !== 'string') continue;
    const probeEntry = probeData[model.id];
    if (!probeEntry) continue;
    const okCaps = CAP_ORDER.filter((cap) => {
      const value = probeEntry[cap];
      return typeof value === 'string' && value.toLowerCase().startsWith('ok');
    });
    if (okCaps.length === 0) continue;
    const existingCaps = Array.isArray(model.capabilities) ? model.capabilities.filter((cap: unknown) => typeof cap === 'string') : [];
    const merged = CAP_ORDER.filter((cap) => new Set([...existingCaps, ...okCaps]).has(cap));
    if (!arraysEqual(existingCaps, merged)) {
      model.capabilities = merged;
      modelsChanged = true;
      updatedModels += 1;
    }
  }
}

if (modelsChanged) {
  saveJson(MODELS_PATH, modelsFile);
}

if (probeChanged) {
  probeFile.data = probeData;
  saveJson(PROBE_PATH, probeFile);
}

if (capsCacheChanged) {
  saveJson(CAPS_CACHE_PATH, capabilitiesCache);
}

console.log(`[applyProbeCapabilities] Updated models: ${updatedModels}`);
console.log(`[applyProbeCapabilities] Removed probe fault entries: ${removedProbeEntries}`);
console.log(`[applyProbeCapabilities] models.json ${modelsChanged ? 'updated' : 'unchanged'}`);
console.log(`[applyProbeCapabilities] probe-tested.json ${probeChanged ? 'cleaned' : 'unchanged'}`);
console.log(`[applyProbeCapabilities] model-capabilities.json ${capsCacheChanged ? 'updated' : 'unchanged'}`);
