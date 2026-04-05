import { urlHasExpectedHostname } from './urlGuards.js';

export type ProviderFamily =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'gemini'
  | 'anthropic'
  | 'xai'
  | 'mock'
  | 'unknown';

export type ProviderIdentityInput =
  | string
  | {
      id?: string | null;
      provider?: string | null;
      type?: string | null;
      provider_url?: string | null;
      url?: string | null;
    };

type ProviderFamilyDetector = {
  family: Exclude<ProviderFamily, 'unknown'>;
  tokens: string[];
  hostnames?: string[];
};

const PROVIDER_FAMILY_DETECTORS: ProviderFamilyDetector[] = [
  { family: 'mock', tokens: ['mock'] },
  {
    family: 'openrouter',
    tokens: ['openrouter'],
    hostnames: ['openrouter.ai'],
  },
  {
    family: 'deepseek',
    tokens: ['deepseek'],
    hostnames: ['api.deepseek.com'],
  },
  {
    family: 'xai',
    tokens: ['xai', 'x-ai'],
    hostnames: ['api.x.ai', 'x.ai'],
  },
  {
    family: 'anthropic',
    tokens: ['anthropic', 'claude'],
    hostnames: ['api.anthropic.com'],
  },
  {
    family: 'gemini',
    tokens: ['gemini', 'google', 'imagen', 'nano-banana'],
    hostnames: ['generativelanguage.googleapis.com'],
  },
  {
    family: 'openai',
    tokens: ['openai'],
    hostnames: ['api.openai.com', 'openai.com'],
  },
];

function normalizeValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function getProviderIdentityFields(input: ProviderIdentityInput): {
  id: string;
  provider: string;
  type: string;
  providerUrl: string;
} {
  if (typeof input === 'string') {
    return {
      id: normalizeValue(input),
      provider: '',
      type: '',
      providerUrl: '',
    };
  }

  return {
    id: normalizeValue(input?.id),
    provider: normalizeValue(input?.provider),
    type: normalizeValue(input?.type),
    providerUrl: normalizeValue(input?.provider_url ?? input?.url),
  };
}

function matchesFamilyToken(values: string[], token: string): boolean {
  return values.some((value) => value === token || value.includes(token));
}

export function resolveProviderFamily(input: ProviderIdentityInput): ProviderFamily {
  const { id, provider, type, providerUrl } = getProviderIdentityFields(input);
  const values = [id, provider, type].filter(Boolean);

  for (const detector of PROVIDER_FAMILY_DETECTORS) {
    if (detector.tokens.some((token) => matchesFamilyToken(values, token))) {
      return detector.family;
    }
    if (
      providerUrl &&
      detector.hostnames?.some((hostname) =>
        urlHasExpectedHostname(providerUrl, hostname),
      )
    ) {
      return detector.family;
    }
  }

  return 'unknown';
}

export function isGoogleFamilyProvider(input: ProviderIdentityInput): boolean {
  return resolveProviderFamily(input) === 'gemini';
}

export function isOpenAiNativeProvider(input: ProviderIdentityInput): boolean {
  return resolveProviderFamily(input) === 'openai';
}

export function isOpenRouterProvider(input: ProviderIdentityInput): boolean {
  return resolveProviderFamily(input) === 'openrouter';
}

export function isXaiProvider(input: ProviderIdentityInput): boolean {
  return resolveProviderFamily(input) === 'xai';
}

export function normalizeProviderFamilyKey(input: ProviderIdentityInput): string {
  const family = resolveProviderFamily(input);
  if (family !== 'unknown') return family;

  const { id } = getProviderIdentityFields(input);
  const dashIndex = id.indexOf('-');
  return dashIndex > 0 ? id.slice(0, dashIndex) : id;
}
