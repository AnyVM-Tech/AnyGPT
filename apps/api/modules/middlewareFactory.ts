import { validateApiKeyAndUsage } from './userData.js';
import { enforceInMemoryRateLimit, RateLimitDecision, RequestTimestampStore, TierRateLimits } from './rateLimit.js';

const API_KEY_MIN_LENGTH = (() => {
  const raw = Number(process.env.API_KEY_MIN_LENGTH);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 32;
})();

const API_KEY_MAX_LENGTH = (() => {
  const raw = Number(process.env.API_KEY_MAX_LENGTH);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 512;
})();

function normalizeApiKeyValue(value: string | null): string | null {
  if (!value) return null;
  const token = String(value).trim();
  if (!token) return null;
  if (API_KEY_MIN_LENGTH > 0 && token.length < API_KEY_MIN_LENGTH) return null;
  if (API_KEY_MAX_LENGTH > 0 && token.length > API_KEY_MAX_LENGTH) return null;
  return token;
}

export function normalizeApiKey(value: string | null): string | null {
  return normalizeApiKeyValue(value);
}

export function extractBearerToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^Bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^Bearer\s+/i, '').trim();
  }
  return trimmed;
}

function isValidRateLimitValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidTierLimits(limits: TierRateLimits | undefined): limits is TierRateLimits {
  if (!limits) return false;
  return isValidRateLimitValue(limits.rps)
    && isValidRateLimitValue(limits.rpm)
    && isValidRateLimitValue(limits.rpd);
}

interface ResponsePayload {
  status: number;
  body: any;
}

interface AuthHandlers {
  extractApiKey: (request: any) => string | null;
  onMissingApiKey: (request: any) => ResponsePayload | Promise<ResponsePayload>;
  onInvalidApiKey: (request: any, details: { apiKey: string; statusCode: number; error?: string }) => ResponsePayload | Promise<ResponsePayload>;
  onInternalError: (request: any, error: unknown) => ResponsePayload | Promise<ResponsePayload>;
  callNext?: boolean;
}

interface RateLimitHandlers {
  onMissingContext: (request: any) => ResponsePayload | Promise<ResponsePayload>;
  onDenied: (request: any, details: { window: 'rps' | 'rpm' | 'rpd'; limit: number; retryAfterSeconds: number }) => ResponsePayload | Promise<ResponsePayload>;
  sharedDecisionProvider?: (request: any, apiKey: string, limits: TierRateLimits) => Promise<RateLimitDecision | null>;
}

interface IpRateLimitHandlers {
  onDenied: (request: any, details: { window: 'rps' | 'rpm' | 'rpd'; limit: number; retryAfterSeconds: number; ip: string }) => ResponsePayload | Promise<ResponsePayload>;
}

async function sendJsonIfOpen(response: any, payload: ResponsePayload) {
  if (!response.completed) {
    return response.status(payload.status).json(payload.body);
  }
  return;
}

function readNonNegativeLimitFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return fallback;
}

export function readTierRateLimitsFromEnv(prefix: string, defaults: TierRateLimits): TierRateLimits {
  return {
    rps: readNonNegativeLimitFromEnv(`${prefix}_RPS`, defaults.rps),
    rpm: readNonNegativeLimitFromEnv(`${prefix}_RPM`, defaults.rpm),
    rpd: readNonNegativeLimitFromEnv(`${prefix}_RPD`, defaults.rpd),
  };
}

export function extractClientIp(request: any): string {
  const forwarded = request?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }

  const realIp = request?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  const cfIp = request?.headers?.['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }

  return request?.ip || 'unknown';
}

export async function runAuthMiddleware(request: any, response: any, next: () => void, handlers: AuthHandlers) {
  try {
    const rawApiKey = handlers.extractApiKey(request);
    const apiKey = normalizeApiKeyValue(rawApiKey);
    if (!apiKey) {
      if (rawApiKey) {
        return sendJsonIfOpen(response, await handlers.onInvalidApiKey(request, {
          apiKey: rawApiKey,
          statusCode: 401,
          error: 'Invalid API key format.'
        }));
      }
      return sendJsonIfOpen(response, await handlers.onMissingApiKey(request));
    }

    const validationResult = await validateApiKeyAndUsage(apiKey);
    if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
      const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401;
      return sendJsonIfOpen(response, await handlers.onInvalidApiKey(request, { apiKey, statusCode, error: validationResult.error }));
    }

    request.apiKey = apiKey;
    request.userId = validationResult.userData.userId;
    request.userRole = validationResult.userData.role;
    request.userTokenUsage = validationResult.userData.tokenUsage;
    request.userTier = validationResult.userData.tier;
    request.tierLimits = validationResult.tierLimits;

    if (handlers.callNext !== false) next();
    return;
  } catch (error) {
    return sendJsonIfOpen(response, await handlers.onInternalError(request, error));
  }
}

export async function runRateLimitMiddleware(
  request: any,
  response: any,
  next: () => void,
  store: RequestTimestampStore,
  handlers: RateLimitHandlers
) {
  const apiKey = normalizeApiKeyValue(typeof request.apiKey === 'string' ? request.apiKey : null);
  const tierLimits = request.tierLimits as TierRateLimits | undefined;

  if (!apiKey || !isValidTierLimits(tierLimits)) {
    return sendJsonIfOpen(response, await handlers.onMissingContext(request));
  }

  if (handlers.sharedDecisionProvider) {
    const sharedDecision = await handlers.sharedDecisionProvider(request, apiKey, tierLimits);
    if (sharedDecision && !sharedDecision.allowed && sharedDecision.window) {
      const retryAfterSeconds = sharedDecision.retryAfterSeconds ?? 1;
      response.setHeader('Retry-After', String(retryAfterSeconds));
      return sendJsonIfOpen(response, await handlers.onDenied(request, {
        window: sharedDecision.window,
        limit: sharedDecision.limit ?? tierLimits[sharedDecision.window],
        retryAfterSeconds,
      }));
    }
  }

  const decision = enforceInMemoryRateLimit(store, apiKey, tierLimits);
  if (!decision.allowed && decision.window) {
    const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
    response.setHeader('Retry-After', String(retryAfterSeconds));
    return sendJsonIfOpen(response, await handlers.onDenied(request, {
      window: decision.window,
      limit: decision.limit ?? tierLimits[decision.window],
      retryAfterSeconds,
    }));
  }

  next();
}

export async function runIpRateLimitMiddleware(
  request: any,
  response: any,
  next: () => void,
  store: RequestTimestampStore,
  limits: TierRateLimits,
  handlers: IpRateLimitHandlers
) {
  const ip = extractClientIp(request);
  const decision = enforceInMemoryRateLimit(store, ip, limits);
  if (!decision.allowed && decision.window) {
    const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
    response.setHeader('Retry-After', String(retryAfterSeconds));
    return sendJsonIfOpen(response, await handlers.onDenied(request, {
      window: decision.window,
      limit: decision.limit ?? limits[decision.window],
      retryAfterSeconds,
      ip,
    }));
  }

  next();
}
