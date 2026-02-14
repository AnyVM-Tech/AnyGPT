import { validateApiKeyAndUsage } from './userData.js';
import { enforceInMemoryRateLimit, RateLimitDecision, RequestTimestampStore, TierRateLimits } from './rateLimit.js';

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

async function sendJsonIfOpen(response: any, payload: ResponsePayload) {
  if (!response.completed) {
    return response.status(payload.status).json(payload.body);
  }
  return;
}

export async function runAuthMiddleware(request: any, response: any, next: () => void, handlers: AuthHandlers) {
  try {
    const apiKey = handlers.extractApiKey(request);
    if (!apiKey) {
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
  const apiKey = request.apiKey;
  const tierLimits = request.tierLimits as TierRateLimits | undefined;

  if (!apiKey || !tierLimits) {
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