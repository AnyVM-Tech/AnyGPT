import crypto from 'crypto';
// Remove direct fs import if no longer needed
// import fs from 'fs';
// Import the singleton DataManager instance
import { dataManager, ModelsFileStructure } from './dataManager.js';
import { logger } from './logger.js';
import { hashToken } from './redaction.js';
import { BASE64_DATA_URL_GLOBAL } from './tokenEstimation.js';
import {
  incrementCompletionRateLimitCounters,
  logCompletionRateLimitIncrementFailure,
} from './completionRateLimit.js';
import {
  getDefaultAdminTierId,
  getFallbackUserTierId,
  loadTiers,
} from './tierManager.js';
import type { TierData, TiersFile } from './tierManager.js';

export type { TierData, TiersFile } from './tierManager.js';

// --- Per-model pricing cache for estimatedCost ---
type SpecialPricingMetric =
  | 'per_image'
  | 'per_request'
  | 'image_input'
  | 'audio_input'
  | 'audio_output';

interface ModelPricing {
  input: number;
  output: number;
  per_image?: number;
  per_request?: number;
  image_input?: number;
  audio_input?: number;
  audio_output?: number;
}

const SPECIAL_PRICING_FIELDS: SpecialPricingMetric[] = [
  'per_image',
  'per_request',
  'image_input',
  'audio_input',
  'audio_output',
];

let _pricingCache: Map<string, ModelPricing> = new Map();
let _avgBlendedRate: number = 0;
let _pricingLastUpdated = 0;
const PRICING_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 minutes
const CODEX_SINGLE_TURN_ONLY = process.env.CODEX_SINGLE_TURN_ONLY === '1';
const RESPONSES_SINGLE_TURN_ONLY = process.env.RESPONSES_SINGLE_TURN_ONLY !== '0';
const MAX_MESSAGE_COUNT = (() => {
  const raw = Number(process.env.MAX_MESSAGE_COUNT);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 200;
})();
const MAX_MESSAGE_PARTS = (() => {
  const raw = Number(process.env.MAX_MESSAGE_PARTS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 2000;
})();
const MAX_MESSAGE_CONTENT_CHARS = (() => {
  const raw = Number(process.env.MAX_MESSAGE_CONTENT_CHARS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 1_000_000;
})();
const MAX_MODEL_ID_LENGTH = (() => {
  const raw = Number(process.env.MAX_MODEL_ID_LENGTH);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 200;
})();
const MAX_ROLE_LENGTH = (() => {
  const raw = Number(process.env.MAX_ROLE_LENGTH);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 32;
})();
const MAX_IMAGE_URL_LENGTH = (() => {
  const raw = Number(process.env.MAX_IMAGE_URL_LENGTH);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 4096;
})();
const MAX_IMAGE_BASE64_CHARS = (() => {
  const raw = Number(process.env.MAX_IMAGE_BASE64_CHARS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 8_000_000;
})();
const MAX_AUDIO_BASE64_CHARS = (() => {
  const raw = Number(process.env.MAX_AUDIO_BASE64_CHARS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 12_000_000;
})();

function ensureLength(value: string, max: number, label: string): void {
  if (max > 0 && value.length > max) {
    throw new Error(`${label} exceeds maximum length (${max}).`);
  }
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.trim());
}

function normalizeStringContentWithInlineMedia(
  content: string,
  textPartType: 'text' | 'input_text' = 'text'
): string | any[] {
  if (typeof content !== 'string' || !content.includes('data:')) {
    return content;
  }

  const regex = new RegExp(BASE64_DATA_URL_GLOBAL.source, BASE64_DATA_URL_GLOBAL.flags);
  const parts: any[] = [];
  let recognizedMediaParts = 0;
  let textLength = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0] || '';
    const mimeType = String(match[1] || '').toLowerCase();
    const payload = String(match[2] || '');
    const matchIndex = typeof match.index === 'number' ? match.index : lastIndex;
    const isImage = mimeType.startsWith('image/');
    const isAudio = mimeType.startsWith('audio/');

    if (!isImage && !isAudio) {
      continue;
    }

    const precedingText = content.slice(lastIndex, matchIndex);
    if (precedingText) {
      textLength += precedingText.length;
      parts.push({ type: textPartType, text: precedingText });
    }

    if (isImage) {
      if (MAX_IMAGE_BASE64_CHARS > 0) {
        ensureLength(payload, MAX_IMAGE_BASE64_CHARS, 'image_url data');
      }
      parts.push({
        type: 'image_url',
        image_url: { url: fullMatch },
      });
    } else {
      if (MAX_AUDIO_BASE64_CHARS > 0) {
        ensureLength(payload, MAX_AUDIO_BASE64_CHARS, 'input_audio.data');
      }
      parts.push({
        type: 'input_audio',
        input_audio: { data: payload, format: mimeType },
      });
    }

    recognizedMediaParts += 1;
    lastIndex = matchIndex + fullMatch.length;
  }

  if (recognizedMediaParts === 0) {
    return content;
  }

  const trailingText = content.slice(lastIndex);
  if (trailingText) {
    textLength += trailingText.length;
    parts.push({ type: textPartType, text: trailingText });
  }

  if (MAX_MESSAGE_CONTENT_CHARS > 0 && textLength > MAX_MESSAGE_CONTENT_CHARS) {
    throw new Error(`message content exceeds maximum length (${MAX_MESSAGE_CONTENT_CHARS}).`);
  }

  const compactParts = parts.filter((part) => {
    if (!part || typeof part !== 'object') return false;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      return part.text.length > 0;
    }
    return true;
  });

  if (compactParts.length === 0) return '';
  if (compactParts.length === 1 && typeof compactParts[0]?.text === 'string') {
    return compactParts[0].text;
  }

  return compactParts;
}

function normalizeStructuredContentParts(content: any[]): any[] {
  const normalized: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      normalized.push(part);
      continue;
    }

    const type = String(part.type || '').toLowerCase();
    if ((type === 'text' || type === 'input_text') && typeof part.text === 'string') {
      const next = normalizeStringContentWithInlineMedia(part.text, type === 'input_text' ? 'input_text' : 'text');
      if (Array.isArray(next)) {
        normalized.push(...next);
      } else {
        normalized.push({ ...part, text: next });
      }
      continue;
    }

    normalized.push(part);
  }
  return normalized;
}

function isResponsesSingleTurnModel(normalizedModelId: string): boolean {
  return normalizedModelId.includes('codex')
    || normalizedModelId.includes('gpt-5')
    || normalizedModelId.includes('gpt-4.1');
}

function collapseMessagesToLatestUserTurn(
  messages: { role: string; content: any }[],
  maxMessages: number = MAX_MESSAGE_COUNT,
): { role: string; content: any }[] {
  const systemMessages = messages.filter((msg) => msg.role === 'system' || msg.role === 'developer');
  const lastUserMessage = [...messages].reverse().find((msg) => msg.role === 'user');
  if (!lastUserMessage) return messages;
  if (maxMessages > 0 && maxMessages <= 1) return [lastUserMessage];

  const allowedSystemMessages = maxMessages > 0
    ? Math.max(maxMessages - 1, 0)
    : systemMessages.length;
  const keptSystemMessages = allowedSystemMessages > 0
    ? systemMessages.slice(-allowedSystemMessages)
    : [];

  return [...keptSystemMessages, lastUserMessage];
}

async function refreshPricingCache(): Promise<void> {
  const now = Date.now();
  if (_pricingCache.size > 0 && (now - _pricingLastUpdated) < PRICING_REFRESH_MS) return;
  try {
    const modelsFile = await dataManager.load<ModelsFileStructure>('models');
    const data = modelsFile?.data || [];
    const next = new Map<string, ModelPricing>();
    const blendedRates: number[] = [];
    for (const m of data) {
      const p = (m as any).pricing;
      if (!p) continue;
      const inp = typeof p.input === 'number' ? p.input : 0;
      const out = typeof p.output === 'number' ? p.output : 0;
      const extraPricing: Partial<Record<SpecialPricingMetric, number>> = {};
      for (const field of SPECIAL_PRICING_FIELDS) {
        const value = typeof p[field] === 'number' ? p[field] : 0;
        if (value > 0) {
          extraPricing[field] = value;
        }
      }
      if (inp > 0 || out > 0 || Object.keys(extraPricing).length > 0) {
        next.set(m.id, { input: inp, output: out, ...extraPricing });
      }
      if (inp > 0 || out > 0) {
        blendedRates.push((inp + out) / 2);
      }
    }
    if (next.size > 0) {
      _pricingCache = next;
      _avgBlendedRate = blendedRates.length > 0
        ? blendedRates.reduce((a, b) => a + b, 0) / blendedRates.length
        : 0;
      _pricingLastUpdated = now;
    }
  } catch {
    // Keep previous cache if models aren't available
  }
}

function calculateRequestCost(
  totalTokens: number,
  modelId?: string,
  promptTokens?: number,
  completionTokens?: number,
  pricingMetric?: SpecialPricingMetric,
  pricingQuantity?: number
): number {
  if (modelId && _pricingCache.has(modelId)) {
    const pricing = _pricingCache.get(modelId)!;
    if (pricingMetric) {
      const unitRate = pricing[pricingMetric];
      const quantity =
        typeof pricingQuantity === 'number' && Number.isFinite(pricingQuantity) && pricingQuantity > 0
          ? pricingQuantity
          : pricingMetric === 'per_request'
            ? 1
            : 0;
      if (typeof unitRate === 'number' && unitRate > 0 && quantity > 0) {
        return unitRate * quantity;
      }
      // Some video models are billed once per request even when the route passes
      // a duration-based video quantity. Fall back to per_request so tracked usage
      // still reflects the configured model price instead of silently billing $0.
      if (
        pricingMetric === 'per_image'
        && typeof pricing.per_request === 'number'
        && pricing.per_request > 0
      ) {
        return pricing.per_request;
      }
    }
    const pTokens = typeof promptTokens === 'number' ? promptTokens : totalTokens;
    const cTokens = typeof completionTokens === 'number' ? completionTokens : 0;
    // pricing.input and pricing.output are $/M tokens
    return (pTokens * pricing.input + cTokens * pricing.output) / 1_000_000;
  }
  // Fallback: blended average rate
  if (_avgBlendedRate > 0) {
    return (totalTokens * _avgBlendedRate) / 1_000_000;
  }
  return 0;
}

function normalizeUsageCounter(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeUsdAmount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function normalizeOptionalCounter(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function normalizeRateLimitValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export type NormalizedTierRateLimits<T extends { rps: number | null; rpm: number | null; rpd: number | null }> =
  Omit<T, 'rps' | 'rpm' | 'rpd'> & { rps: number; rpm: number; rpd: number };

export function normalizeTierRateLimits<T extends { rps: number | null; rpm: number | null; rpd: number | null }>(
  limits: T
): NormalizedTierRateLimits<T> {
  return {
    ...limits,
    rps: normalizeRateLimitValue(limits.rps),
    rpm: normalizeRateLimitValue(limits.rpm),
    rpd: normalizeRateLimitValue(limits.rpd),
  } as NormalizedTierRateLimits<T>;
}

function getUtcDayBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function isValidUtcDayBucket(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function getBillingPeriodTokenUsage(userData: Pick<UserData, 'tokenUsage' | 'paidTokenUsage'>): number {
  const totalTokenUsage = normalizeUsageCounter(userData.tokenUsage);
  const paidTokenUsage = Math.min(
    totalTokenUsage,
    normalizeUsageCounter(userData.paidTokenUsage)
  );
  return Math.max(0, totalTokenUsage - paidTokenUsage);
}

export interface UserData {
  userId: string;
  tokenUsage: number;
  requestCount: number;
  dailyRequestCount?: number;
  dailyRequestDate?: string;
  role: 'admin' | 'user';
  tier: keyof TiersFile; // Use keyof TiersFile for better type safety
  estimatedCost?: number;
  paidTokenUsage?: number;
  paidRequestCount?: number;
  paidEstimatedCost?: number;
  billingPeriodStartedAt?: string;
  lastBillingSettlementAt?: string;
}
// Define KeysFile structure locally or import if shared
export interface KeysFile { [apiKey: string]: UserData; }

export function buildFreshUsageAccounting(startedAt: string = new Date().toISOString()): Pick<
  UserData,
  'tokenUsage' | 'requestCount' | 'dailyRequestCount' | 'dailyRequestDate' | 'estimatedCost' | 'paidTokenUsage' | 'paidRequestCount' | 'paidEstimatedCost' | 'billingPeriodStartedAt'
> {
  return {
    tokenUsage: 0,
    requestCount: 0,
    dailyRequestCount: 0,
    dailyRequestDate: getUtcDayBucket(),
    estimatedCost: 0,
    paidTokenUsage: 0,
    paidRequestCount: 0,
    paidEstimatedCost: 0,
    billingPeriodStartedAt: startedAt,
  };
}

export function settleUserBillingPeriod(userData: UserData, settledAt: string = new Date().toISOString()): UserData {
  const tokenUsage = normalizeUsageCounter(userData.tokenUsage);
  const requestCount = normalizeUsageCounter(userData.requestCount);
  const estimatedCost = normalizeUsdAmount(userData.estimatedCost);

  return {
    ...userData,
    tokenUsage,
    requestCount,
    estimatedCost,
    paidTokenUsage: tokenUsage,
    paidRequestCount: requestCount,
    paidEstimatedCost: estimatedCost,
    billingPeriodStartedAt: settledAt,
    lastBillingSettlementAt: settledAt,
  };
}

export function resetUserUsageAccounting(userData: UserData, resetAt: string = new Date().toISOString()): UserData {
  return {
    ...userData,
    tokenUsage: 0,
    requestCount: 0,
    dailyRequestCount: 0,
    dailyRequestDate: getUtcDayBucket(new Date(resetAt)),
    estimatedCost: 0,
    paidTokenUsage: 0,
    paidRequestCount: 0,
    paidEstimatedCost: 0,
    billingPeriodStartedAt: resetAt,
    lastBillingSettlementAt: resetAt,
  };
}

// --- Functions using DataManager ---

export async function generateUserApiKey(
  userId: string,
  role: 'admin' | 'user' = 'user',
  tier?: keyof TiersFile | string
): Promise<string> {
  if (!userId) throw new Error('User ID required.');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const currentKeys = await dataManager.load<KeysFile>('keys');
  const tiers = await loadTiers();

  if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has an API key.`);
  }

  const requestedTier = typeof tier === 'string' ? tier.trim() : '';
  if (requestedTier && !tiers[requestedTier]) {
    throw new Error(`Unknown tier '${requestedTier}'.`);
  }
  const fallbackTier = getFallbackUserTierId(tiers);
  const finalTier = (requestedTier || fallbackTier || '') as keyof TiersFile;
  if (!finalTier || !tiers[finalTier]) {
    throw new Error('Configuration error: No tiers defined.');
  }

  currentKeys[apiKey] = {
    userId,
    role,
    tier: finalTier,
    ...buildFreshUsageAccounting(),
  };
  await dataManager.save<KeysFile>('keys', currentKeys);
  console.log(`Generated key for ${userId} with role: ${role} and tier: ${finalTier}.`);
  return apiKey;
}

export async function generateAdminApiKey(userId: string): Promise<string> {
  if (!userId) throw new Error('User ID required.');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const currentKeys = await dataManager.load<KeysFile>('keys');
  const tiers = await loadTiers();

  if (Object.values(currentKeys).find(data => data.userId === userId)) {
    throw new Error(`User ID '${userId}' already has API key.`);
  }
  const adminTier = getDefaultAdminTierId(tiers) as keyof TiersFile | null;
  if (!adminTier) throw new Error('Config error: No admin tier found.');

  currentKeys[apiKey] = {
    userId,
    role: 'admin',
    tier: adminTier,
    ...buildFreshUsageAccounting(),
  };
  await dataManager.save<KeysFile>('keys', currentKeys);
  console.log(`Generated admin key for ${userId}.`);
  return apiKey;
}

// Becomes async due to dataManager.load
export async function validateApiKeyAndUsage(apiKey: string): Promise<{ valid: boolean; userData?: UserData; tierLimits?: TierData, error?: string }> {
  const apiKeyHash = hashToken(apiKey).slice(0, 12);
  logger.debug(`[validateApiKeyAndUsage] Validating API key hash: ${apiKeyHash}`);
  const [currentKeys, tiers] = await Promise.all([
    dataManager.load<KeysFile>('keys'),
    loadTiers(),
  ]);
  logger.debug(`[validateApiKeyAndUsage] Loaded keys count: ${Object.keys(currentKeys).length}`);
  const userData = currentKeys[apiKey];
  logger.debug(`[validateApiKeyAndUsage] User data for API key hash: ${apiKeyHash} => ${userData ? 'found' : 'missing'}`);

  if (!userData) {
      logger.warn(`[validateApiKeyAndUsage] API key not found (hash: ${apiKeyHash})`);
      return { valid: false, error: 'API key not found.' };
  }

  if (typeof userData.tokenUsage !== 'number' || Number.isNaN(userData.tokenUsage) || userData.tokenUsage < 0) {
      userData.tokenUsage = 0;
    }
    if (typeof userData.requestCount !== 'number' || Number.isNaN(userData.requestCount) || userData.requestCount < 0) {
      userData.requestCount = 0;
    }
    if (typeof userData.dailyRequestCount !== 'number' || Number.isNaN(userData.dailyRequestCount) || userData.dailyRequestCount < 0) {
      userData.dailyRequestCount = 0;
    }
    if (typeof userData.dailyRequestDate !== 'undefined' && !isValidUtcDayBucket(userData.dailyRequestDate)) {
      userData.dailyRequestDate = getUtcDayBucket();
      userData.dailyRequestCount = 0;
    }
    if (typeof userData.paidTokenUsage !== 'number' || Number.isNaN(userData.paidTokenUsage) || userData.paidTokenUsage < 0) {
      userData.paidTokenUsage = 0;
    }
    if (typeof userData.paidRequestCount !== 'number' || Number.isNaN(userData.paidRequestCount) || userData.paidRequestCount < 0) {
      userData.paidRequestCount = 0;
    }
    if (typeof userData.paidEstimatedCost !== 'number' || Number.isNaN(userData.paidEstimatedCost) || userData.paidEstimatedCost < 0) {
      userData.paidEstimatedCost = 0;
    }

  const tierDefinition = tiers[userData.tier];
  if (!tierDefinition) {
      const errorMsg = `Invalid tier ('${userData.tier}') for API key hash ${apiKeyHash}`;
      logger.warn(`[validateApiKeyAndUsage] ${errorMsg}`);
      return { valid: false, error: errorMsg, userData };
  }

  const tierLimits = normalizeTierRateLimits(tierDefinition);
  logger.debug(`[validateApiKeyAndUsage] Tier limits resolved for API key hash: ${apiKeyHash}`);

  const billingPeriodTokenUsage = getBillingPeriodTokenUsage(userData);

  if (tierLimits.max_tokens !== null && billingPeriodTokenUsage >= tierLimits.max_tokens) {
      const errorMsg = `Token limit (${tierLimits.max_tokens}) reached for current billing period for API key hash ${apiKeyHash}`;
      logger.warn(`[validateApiKeyAndUsage] ${errorMsg}`);
      return { valid: false, error: errorMsg, userData, tierLimits };
  }

  logger.debug(`[validateApiKeyAndUsage] Validation successful for API key hash: ${apiKeyHash}`);
  return { valid: true, userData, tierLimits }; 
}

// Becomes async due to dataManager.load
export async function getTierLimits(apiKey: string): Promise<TierData | null> {
   const [keys, tiers] = await Promise.all([
    dataManager.load<KeysFile>('keys'),
    loadTiers(),
   ]);
   const userData = keys[apiKey];
   if (!userData) { return null; }
   const tier = tiers[userData.tier];
   if (!tier) { return null; }
   return normalizeTierRateLimits(tier);
}

// Parse and validate request body for chat/completions; caller supplies the already-parsed body.
export function extractMessageFromRequestBody(requestBody: any): {
  messages: { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }[];
  model: string;
  max_tokens?: number;
} {
  try {
    if (!requestBody || typeof requestBody !== 'object') throw new Error('Invalid body.');
    if (!Array.isArray(requestBody.messages)) throw new Error('Invalid messages format.');
    if (typeof requestBody.model !== 'string' || !requestBody.model) {
       throw new Error('model parameter is required.');
    }
    if (MAX_MODEL_ID_LENGTH > 0) {
      ensureLength(requestBody.model, MAX_MODEL_ID_LENGTH, 'model');
    }

    // Basic validation for content: allow string or an array of typed parts
    const normalizedMessages = requestBody.messages.map((m: any) => {
      if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
        throw new Error('Each message must include a role.');
      }
      if (MAX_ROLE_LENGTH > 0) {
        ensureLength(m.role, MAX_ROLE_LENGTH, 'role');
      }
      const role = m.role;
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : undefined;
      const toolCallId = typeof m.tool_call_id === 'string' && m.tool_call_id.trim() ? m.tool_call_id.trim() : undefined;
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : undefined;
      const content = typeof m.content === 'string'
        ? normalizeStringContentWithInlineMedia(m.content, 'text')
        : (Array.isArray(m.content) ? normalizeStructuredContentParts(m.content) : m.content);
      const isStringContent = typeof content === 'string';
      const isArrayContent = Array.isArray(content);
      const allowEmptyAssistantToolContent =
        (content === null || typeof content === 'undefined')
        && role === 'assistant'
        && Array.isArray(toolCalls)
        && toolCalls.length > 0;
      if (!isStringContent && !isArrayContent && !allowEmptyAssistantToolContent) {
        throw new Error('Message content must be a string or an array of content parts.');
      }
      const normalizedContent = allowEmptyAssistantToolContent ? '' : content;
      if (typeof normalizedContent === 'string' && MAX_MESSAGE_CONTENT_CHARS > 0) {
        ensureLength(normalizedContent, MAX_MESSAGE_CONTENT_CHARS, 'message content');
      }
      if (Array.isArray(normalizedContent)) {
        if (MAX_MESSAGE_PARTS > 0 && normalizedContent.length > MAX_MESSAGE_PARTS) {
          throw new Error(`Too many message parts. Limit is ${MAX_MESSAGE_PARTS}.`);
        }
        normalizedContent.forEach((part: any) => {
          if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
            throw new Error('Invalid content part: missing type.');
          }
          if (part.type === 'text' && typeof part.text !== 'string') {
            throw new Error('Text parts require a text field.');
          }
          if (part.type === 'text' && MAX_MESSAGE_CONTENT_CHARS > 0) {
            ensureLength(part.text, MAX_MESSAGE_CONTENT_CHARS, 'text content');
          }
          if (part.type === 'image_url') {
            if (!part.image_url || typeof part.image_url.url !== 'string') {
              throw new Error('image_url parts require image_url.url.');
            }
            const url = part.image_url.url;
            if (!isDataUrl(url) && MAX_IMAGE_URL_LENGTH > 0) {
              ensureLength(url, MAX_IMAGE_URL_LENGTH, 'image_url.url');
            }
            if (isDataUrl(url)) {
              const match = url.match(/^data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
              const mimeType = (match?.[1] || '').toLowerCase();
              const payload = match?.[2] || '';
              if (mimeType.startsWith('image/') && MAX_IMAGE_BASE64_CHARS > 0) {
                ensureLength(payload, MAX_IMAGE_BASE64_CHARS, 'image_url data');
              }
            }
          }
          if (part.type === 'input_audio') {
            if (!part.input_audio || typeof part.input_audio.data !== 'string' || typeof part.input_audio.format !== 'string') {
              throw new Error('input_audio parts require base64 data and format.');
            }
            if (MAX_AUDIO_BASE64_CHARS > 0) {
              ensureLength(part.input_audio.data, MAX_AUDIO_BASE64_CHARS, 'input_audio.data');
            }
          }
        });
      }
      const normalizedMessage: { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string } = {
        role,
        content: normalizedContent,
      };
      if (Array.isArray(toolCalls) && toolCalls.length > 0) normalizedMessage.tool_calls = toolCalls;
      if (toolCallId) normalizedMessage.tool_call_id = toolCallId;
      if (name) normalizedMessage.name = name;
      return normalizedMessage;
    });
    
    let maxTokens: number | undefined = undefined;
    if (requestBody.max_tokens !== undefined && requestBody.max_tokens !== null) {
      const parsedTokens = parseInt(requestBody.max_tokens, 10);
      if (isNaN(parsedTokens) || parsedTokens <= 0) throw new Error('Invalid max_tokens.');
      maxTokens = parsedTokens;
    }
    let trimmedMessages = normalizedMessages;
    while (trimmedMessages.length > 0) {
      const lastRole = trimmedMessages[trimmedMessages.length - 1]?.role;
      if (lastRole === 'assistant' || lastRole === 'system' || lastRole === 'developer') {
        trimmedMessages = trimmedMessages.slice(0, -1);
        continue;
      }
      break;
    }
    if (trimmedMessages.length === 0) {
      throw new Error('At least one user message is required.');
    }

    const normalizedModelId = String(requestBody.model || '').toLowerCase();
    const isCodexModel = normalizedModelId.includes('codex');
    const userMessages = trimmedMessages.filter((msg: { role: string; content: any }) => msg.role === 'user');
    const hasToolingRequest = (Array.isArray(requestBody.tools) && requestBody.tools.length > 0)
      || typeof requestBody.tool_choice !== 'undefined';
    const hasStructuredHistory = trimmedMessages.some((msg: { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }) =>
      msg.role === 'assistant'
      || msg.role === 'tool'
      || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)
      || typeof msg.tool_call_id === 'string'
      || typeof msg.name === 'string'
    );
    const canSafelyCollapseToSingleTurn = !hasToolingRequest && !hasStructuredHistory;
    const shouldCollapseToSingleTurn =
      canSafelyCollapseToSingleTurn
      && (
        (isCodexModel && CODEX_SINGLE_TURN_ONLY)
        || (RESPONSES_SINGLE_TURN_ONLY && isResponsesSingleTurnModel(normalizedModelId) && userMessages.length > 1)
      );

    if (shouldCollapseToSingleTurn) {
      trimmedMessages = collapseMessagesToLatestUserTurn(trimmedMessages);
    }

    if (MAX_MESSAGE_COUNT > 0 && trimmedMessages.length > MAX_MESSAGE_COUNT) {
      trimmedMessages = collapseMessagesToLatestUserTurn(trimmedMessages, MAX_MESSAGE_COUNT);
    }

    if (MAX_MESSAGE_COUNT > 0 && trimmedMessages.length > MAX_MESSAGE_COUNT) {
      throw new Error(`Too many messages. Limit is ${MAX_MESSAGE_COUNT}.`);
    }

    if (CODEX_SINGLE_TURN_ONLY && isCodexModel) {
      const lastUserMessage = [...trimmedMessages].reverse().find((msg: { role: string; content: any }) => msg.role === 'user');
      if (!lastUserMessage) {
        throw new Error('At least one user message is required.');
      }
      const userContent = lastUserMessage.content;
      if (typeof userContent === 'string' && userContent.trim().length < 2) {
        throw new Error('User message too short for codex; provide a longer prompt.');
      }
    }

    return { messages: trimmedMessages, model: requestBody.model, max_tokens: maxTokens };
  } catch(error) {
    console.error("Error parsing request:", error);
    throw new Error(`Request parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Becomes async due to dataManager load/save
export async function updateUserTokenUsage(
  numberOfTokens: number,
  apiKey: string,
  options: {
    incrementRequest?: boolean;
    modelId?: string;
    promptTokens?: number;
    completionTokens?: number;
    pricingMetric?: SpecialPricingMetric;
    pricingQuantity?: number;
  } = {}
): Promise<void> {
  if (typeof numberOfTokens !== 'number' || isNaN(numberOfTokens) || numberOfTokens < 0) {
      logger.warn(`Invalid token count (${numberOfTokens}) for key ${hashToken(apiKey).slice(0, 12)}.`); return;
  }
  const incrementRequest = options.incrementRequest !== false;

  // Ensure pricing cache is warm
  await refreshPricingCache();

  const requestCost = calculateRequestCost(
    numberOfTokens,
    options.modelId,
    options.promptTokens,
    options.completionTokens,
    options.pricingMetric,
    options.pricingQuantity
  );

  const tiers = await loadTiers();
  let keyFound = false;

  await dataManager.updateWithLock<KeysFile>('keys', (currentKeys) => {
    const userData = currentKeys[apiKey];
    if (!userData) {
      return currentKeys;
    }

    keyFound = true;
    userData.tokenUsage = (userData.tokenUsage || 0) + numberOfTokens;
    userData.requestCount = (userData.requestCount || 0) + (incrementRequest ? 1 : 0);
    const todayBucket = getUtcDayBucket();
    const currentBucket = isValidUtcDayBucket(userData.dailyRequestDate) ? userData.dailyRequestDate : null;
    if (currentBucket !== todayBucket) {
      userData.dailyRequestDate = todayBucket;
      userData.dailyRequestCount = 0;
    }
    const previousDailyRequestCount = normalizeUsageCounter(userData.dailyRequestCount);
    if (incrementRequest) {
      userData.dailyRequestCount = previousDailyRequestCount + 1;
      const currentTier = tiers[userData.tier];
      const softRpd = normalizeOptionalCounter(currentTier?.soft_rpd);
      if (softRpd !== null && previousDailyRequestCount <= softRpd && userData.dailyRequestCount > softRpd) {
        const hardRpd = normalizeOptionalCounter(currentTier?.rpd);
        logger.warn(
          `[UsageWarning] API key ${hashToken(apiKey).slice(0, 12)} (${userData.userId}) exceeded its soft daily request target (${softRpd}) on ${todayBucket}. Current billed requests today: ${userData.dailyRequestCount}${hardRpd !== null ? ` / hard cap ${hardRpd}` : ''}.`
        );
      }
    } else {
      userData.dailyRequestCount = previousDailyRequestCount;
    }
    userData.paidTokenUsage = normalizeUsageCounter(userData.paidTokenUsage);
    userData.paidRequestCount = normalizeUsageCounter(userData.paidRequestCount);
    userData.paidEstimatedCost = normalizeUsdAmount(userData.paidEstimatedCost);
    if (requestCost > 0) {
      // Use 6 decimal places to avoid rounding away sub-cent per-request costs
      userData.estimatedCost = normalizeUsdAmount((userData.estimatedCost || 0) + requestCost);
    } else if (typeof userData.estimatedCost === 'undefined') {
      userData.estimatedCost = 0;
    }
    if (!userData.billingPeriodStartedAt) {
      userData.billingPeriodStartedAt = new Date().toISOString();
    }
    currentKeys[apiKey] = userData;
    return currentKeys;
  });

  if (!keyFound) {
    logger.warn(`Update token usage failed: key ${hashToken(apiKey).slice(0, 12)} not found.`);
    return;
  }

  if (!incrementRequest) {
    return;
  }

  try {
    await incrementCompletionRateLimitCounters(apiKey);
  } catch (error) {
    logCompletionRateLimitIncrementFailure(apiKey, error);
  }
}
