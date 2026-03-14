import type { Request, Response } from '../lib/uws-compat.js';
import redis from './db.js';
import { incrementSharedRateLimitCounters } from './rateLimitRedis.js';
import { evaluateSharedRateLimit, type RequestTimestampStore } from './rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware, extractBearerToken, normalizeApiKey } from './middlewareFactory.js';
import { dataManager } from './dataManager.js';
import { logError } from './errorLogger.js';
import { logger } from './logger.js';
import { redactAuthorizationHeader, redactToken } from './redaction.js';
import type { KeysFile, TierData } from './userData.js';
import tiersData from '../tiers.json' with { type: 'json' };

const RATE_LIMIT_KEY_PREFIX = 'api:ratelimit:';

declare module '../lib/uws-compat.js' {
  interface Request {
    apiKey?: string; userId?: string; userRole?: string;
    userTokenUsage?: number; userTier?: string;
    tierLimits?: TierData;
  }
}

export async function incrementSharedCounters(apiKey: string) {
  try {
    return await incrementSharedRateLimitCounters(redis, RATE_LIMIT_KEY_PREFIX, apiKey);
  } catch (err) {
    console.warn('[RateLimit] Shared counter failure, falling back to in-memory.', err);
    return null;
  }
}

export function isGeminiFreeTierZeroQuota(errorText: string): boolean {
  const lower = String(errorText || '').toLowerCase();
  if (!lower.includes('free_tier')) return false;
  return /limit:\s*0/.test(lower);
}

export function formatRateLimitMessage(retryAfterSeconds?: number | null): string {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return `Rate limit or quota exceeded. Please retry after ${retryAfterSeconds}s.`;
  }
  return 'Rate limit or quota exceeded. Please retry later.';
}

export function getServiceTierForUserTier(userTier?: string): string {
  return String(userTier || '').toLowerCase() === 'free' ? 'standard' : 'priority';
}

export async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  logger.debug(`[AuthMiddleware] Request received at ${request.path} with method ${request.method}`);
  logger.debug(`[AuthMiddleware] Authorization header: ${redactAuthorizationHeader(request.headers['authorization'] as string | undefined) || 'None'}`);
  logger.debug(`[AuthMiddleware] x-api-key header: ${redactToken(request.headers['x-api-key'] as string | undefined) || 'None'}`);

  return runAuthMiddleware(request, response, next, {
    callNext: true,
    extractApiKey: (req) => {
      const authHeader = req.headers['authorization'] || req.headers['Authorization'];
      const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
      if (bearer) return bearer;
      const apiKeyHeader = req.headers['api-key'] ?? req.headers['x-api-key'];
      return (typeof apiKeyHeader === 'string' && apiKeyHeader) ? apiKeyHeader : null;
    },
    onMissingApiKey: async (req) => {
      await logError({ message: 'Unauthorized: Missing API key' }, req);
      return { status: 401, body: { error: 'Unauthorized: Missing or invalid API key header.', timestamp: new Date().toISOString() } };
    },
    onInvalidApiKey: async (req, details) => {
      const errorMessage = `Unauthorized: ${details.error || 'Invalid key/config.'}`;
      await logError({ message: errorMessage, statusCode: details.statusCode, apiKey: redactToken(details.apiKey) }, req);
      return { status: details.statusCode, body: { error: errorMessage, timestamp: new Date().toISOString() } };
    },
    onInternalError: async (req, error) => {
      await logError(error, req);
      console.error('Error during auth/usage check:', error);
      return { status: 500, body: { error: 'Internal Server Error', reference: 'Error during authentication processing.', timestamp: new Date().toISOString() } };
    },
  });
}

export async function authKeyOnlyMiddleware(request: Request, response: Response, next: () => void) {
  try {
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    let apiKey: string | null = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
    if (!apiKey && typeof request.headers['api-key'] === 'string') {
      apiKey = request.headers['api-key'];
    } else if (!apiKey && typeof request.headers['x-api-key'] === 'string') {
      apiKey = request.headers['x-api-key'];
    }
    apiKey = normalizeApiKey(apiKey);

    if (!apiKey) {
      return response.status(401).json({
        error: 'Unauthorized: Missing or invalid API key header.',
        timestamp: new Date().toISOString(),
      });
    }

    const keys = await dataManager.load<KeysFile>('keys');
    const userData = keys[apiKey];
    if (!userData) {
      return response.status(401).json({
        error: 'Unauthorized: Invalid API key.',
        timestamp: new Date().toISOString(),
      });
    }

    const tierLimits = tiersData[userData.tier as keyof typeof tiersData];
    if (!tierLimits) {
      return response.status(401).json({
        error: 'Unauthorized: Invalid API key configuration.',
        timestamp: new Date().toISOString(),
      });
    }

    request.apiKey = apiKey;
    request.userId = userData.userId;
    request.userRole = userData.role;
    request.userTokenUsage = userData.tokenUsage;
    request.userTier = userData.tier;
    request.tierLimits = tierLimits;

    next();
  } catch (error: any) {
    await logError({ message: 'Error during key-only authentication', errorMessage: error?.message }, request);
    if (!response.completed) {
      response.status(500).json({
        error: 'Internal Server Error',
        reference: 'Error during authentication processing.',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export function createRateLimitMiddleware(requestTimestamps: RequestTimestampStore) {
  return async function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    return runRateLimitMiddleware(
      request,
      response,
      next,
      requestTimestamps,
      {
        onMissingContext: (req) => {
          const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (rateLimitMiddleware).';
          logError({ message: errMsg, requestPath: req.path }, req).catch(e => console.error('Failed background log:', e));
          console.error(errMsg);
          return { status: 500, body: { error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp: new Date().toISOString() } };
        },
        onDenied: (req, details) => {
          const windowLabel = details.window.toUpperCase();
          logError({ message: `Rate limit exceeded: Max ${details.limit} ${windowLabel}.`, apiKey: redactToken(req.apiKey) }, req).catch(e => console.error('Failed background log:', e));
          return { status: 429, body: { error: `Rate limit exceeded: Max ${details.limit} ${windowLabel}.`, timestamp: new Date().toISOString() } };
        },
        sharedDecisionProvider: async (_req, apiKey, limits) => {
          const sharedCounts = await incrementSharedCounters(apiKey);
          if (!sharedCounts) return null;
          return evaluateSharedRateLimit(sharedCounts, limits);
        },
      }
    );
  };
}
