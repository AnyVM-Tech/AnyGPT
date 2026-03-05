import { RequestContext, WSWrapper } from '../lib/uws-compat.js';
import { messageHandler } from '../providers/handler.js';
import type { IMessage } from '../providers/interfaces.js';
import { validateApiKeyAndUsage, updateUserTokenUsage } from '../modules/userData.js';
import { normalizeApiKey } from '../modules/middlewareFactory.js';
import { logError } from '../modules/errorLogger.js';
import redis from '../modules/db.js';
import { incrementSharedRateLimitCounters } from '../modules/rateLimitRedis.js';
import { estimateTokensFromText } from '../modules/tokenEstimation.js';

// Lightweight structures for WebSocket JSON protocol
// Incoming message shapes
// 1. Auth handshake: { type: 'auth', apiKey: '...' }
// 2. Chat completions: { type: 'chat.completions', model: 'model-id', messages: [{ role: 'user'|'system'|'assistant', content: '...'}], requestId?: string }
// 3. Ping: { type: 'ping' }
// 4. Future extensibility: other route-aligned types
//
// Outgoing messages examples:
// - Auth OK: { type: 'auth.ok' }
// - Auth error: { type: 'error', code: 'auth', message: '...' }
// - Chat start: { type: 'chat.start', requestId }
// - Chat chunk (future streaming): { type: 'chat.delta', requestId, delta: '...' }
// - Chat completion: { type: 'chat.complete', requestId, response, usage: { total_tokens }, latencyMs, providerId }
// - Error: { type: 'error', code, message, requestId? }
// - Pong: { type: 'pong' }

interface RateWindow { timestamps: number[]; }

// Internal representation of chat messages passed to messageHandler
type WsChatMessage = IMessage;

interface WsClientContext {
  apiKey?: string;
  userId?: string;
  tierLimits?: TierLimits;
  rate: { second: RateWindow; minute: RateWindow; day: RateWindow };
  authenticated: boolean;
  /**
   * Per-connection cache of the most recent shared rate-limit snapshot from Redis.
   * This reduces redundant Redis round-trips for bursts of messages using the same API key.
   */
  sharedRateCache?: {
    value: { rps: number; rpm: number; rpd: number } | null;
    fetchedAt: number;
  };
}

interface TierLimits { rps: number; rpm: number; rpd: number; }

interface ToolCallFunction {
  name: string;
  arguments: string;
}

interface ToolCall {
  id: string;
  type: 'function' | string;
  function: ToolCallFunction;
}

// Simplified, OpenAI-compatible tool definition for chat completions
interface WsToolFunction {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface WsToolDefinition {
  type: 'function' | string;
  function: WsToolFunction;
  // Allow additional provider-specific fields without losing type safety
  [key: string]: unknown;
}

type WsToolChoiceMode = 'auto' | 'none' | 'required';

interface WsToolChoiceObject {
  type: 'function' | string;
  function: {
    name: string;
    // Extra fields are allowed for extensibility
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type WsToolChoice = WsToolChoiceMode | WsToolChoiceObject;

interface WsReasoningConfig {
  // Whether to enable provider-specific reasoning / planning features
  enabled?: boolean;
  // Provider-specific configuration bag
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

type WsReasoningEffort = 'low' | 'medium' | 'high' | string;

interface BaseMessage { type: string; }
interface PingMessage extends BaseMessage { type: 'ping'; }
interface AuthMessage extends BaseMessage { type: 'auth'; apiKey: string; }
interface ChatCompletionsMessage extends BaseMessage {
  type: 'chat.completions';
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  requestId?: string;
  stream?: boolean;
  tools?: WsToolDefinition[];
  tool_choice?: WsToolChoice;
  reasoning?: WsReasoningConfig;
  reasoning_effort?: WsReasoningEffort;
}

type IncomingMessage = PingMessage | AuthMessage | ChatCompletionsMessage;

interface BaseResponse { type: string; }
interface PongResponse extends BaseResponse { type: 'pong'; }
interface AuthOkResponse extends BaseResponse { type: 'auth.ok'; already?: boolean; tier?: string; role?: string; }
interface ErrorResponse extends BaseResponse { type: 'error'; code: string; message: string; requestId?: string; }
interface ChatStartResponse extends BaseResponse { type: 'chat.start'; requestId?: string; }
interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; delta: { content?: string; tool_calls?: ToolCall[] }; finish_reason: string | null }>;
}
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string; tool_calls?: ToolCall[] }; finish_reason: string }>;
  usage: { total_tokens: number };
}
interface ChatCompleteResponse extends BaseResponse {
  type: 'chat.complete';
  requestId?: string;
  response: OpenAIResponse;
  latencyMs: number;
  providerId?: string;
}

type OutgoingResponse =
  | PongResponse
  | AuthOkResponse
  | ErrorResponse
  | ChatStartResponse
  | ChatCompleteResponse
  | OpenAIStreamChunk;

const wsClients = new Set<WSWrapper>();
const WS_RATE_PREFIX = 'ws:ratelimit:';
const UNAUTH_RPS = 1;
const UNAUTH_RPM = 5;
const UNAUTH_RPD = 50;

function createRedisDuplicate(role: 'subscriber' | 'publisher') {
  if (!redis) return null;
  try {
    const client = redis.duplicate();

    client.on('error', (err: any) => {
      // Log but do not crash the process if a duplicated client encounters errors.
      logError({ message: `[WS PubSub] Redis ${role} client error`, errorMessage: err?.message, errorStack: err?.stack });
    });

    client.on('ready', () => {
      console.info(`[WS PubSub] Redis ${role} client is ready`);
    });

    return client;
  } catch (err) {
    const error = err as Error;
    logError({ message: `[WS PubSub] Failed to duplicate Redis client for ${role}`, errorMessage: error.message, errorStack: error.stack });
    return null;
  }
}

const redisSubscriber = createRedisDuplicate('subscriber');
const redisPublisher = createRedisDuplicate('publisher');

async function publishWsBroadcast(payload: any) {
  if (!redisPublisher || redisPublisher.status !== 'ready') return;
  try {
    await redisPublisher.publish('anygpt:ws:broadcast', JSON.stringify(payload));
  } catch (err) {
    console.warn('[WS PubSub] Failed to publish broadcast:', err);
  }
}

if (redisSubscriber) {
  redisSubscriber.on('message', (_channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message);
      wsClients.forEach(ws => {
        try { ws.send(JSON.stringify(parsed)); } catch { /* ignore */ }
      });
    } catch (err) {
      console.warn('[WS PubSub] Failed to process incoming broadcast:', err);
    }
  });

  const subscribeToChannel = () => {
    redisSubscriber.subscribe('anygpt:ws:broadcast').catch((err: unknown) => {
      console.warn('[WS PubSub] Failed to subscribe to channel:', err);
    });
  };

  if (redisSubscriber.status === 'ready') {
    // Already connected; subscribe immediately.
    subscribeToChannel();
  } else {
    // Defer subscription until the duplicated client is ready.
    redisSubscriber.once('ready', subscribeToChannel);
  }
}

async function checkSharedRateLimit(apiKey: string, limits: TierLimits) {
  try {
    return await incrementSharedRateLimitCounters(redis, WS_RATE_PREFIX, apiKey);
  } catch (err) {
    console.warn('[WS RateLimit] Shared counter failure, falling back to per-connection window.', err);
    return null;
  }
}

interface StreamResult {
  type: string;
  chunk?: string;
  latency?: number;
  providerId?: string;
  tokenUsage?: number;
}

interface MessageResult {
  response: string;
  tokenUsage?: number;
  providerId?: string;
  tool_calls?: ToolCall[];
  finish_reason?: string;
}

function estimateTokens(text: string): number { return estimateTokensFromText(text); }
function prune(window: RateWindow, cutoff: number): void { window.timestamps = window.timestamps.filter(ts => ts >= cutoff); }

export function attachWebSocket(app: { ws: (path: string, handler: (ws: WSWrapper, req: RequestContext) => void) => void }) {
  app.ws('/ws', (ws: WSWrapper, req: RequestContext) => {
    const ctx: WsClientContext = {
      rate: { second: { timestamps: [] }, minute: { timestamps: [] }, day: { timestamps: [] } },
      authenticated: false,
      sharedRateCache: { value: null, fetchedAt: 0 }
    };

    const send = (data: OutgoingResponse): void => {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        logError({
          message: 'WebSocket send failed',
          error: err,
          // Best-effort context; may help debugging without changing behavior.
          wsRoute: '/ws',
          messageType: (data as any)?.type
        });
      }
    };

    // Small per-connection TTL (in ms) for caching shared rate-limit state from Redis.
    const SHARED_RATE_CACHE_TTL_MS = 150;

    const getSharedRateLimitForCtx = async (): Promise<{ rps: number; rpm: number; rpd: number } | null> => {
      if (!ctx.apiKey || !ctx.tierLimits) {
        return null;
      }
      const now = Date.now();
      const cache = ctx.sharedRateCache;
      if (cache && now - cache.fetchedAt <= SHARED_RATE_CACHE_TTL_MS) {
        return cache.value;
      }
      const shared = await checkSharedRateLimit(ctx.apiKey, ctx.tierLimits);
      ctx.sharedRateCache = { value: shared, fetchedAt: now };
      return shared;
    };

    const rateCheck = async (): Promise<boolean> => {
      const now = Date.now();

      // Always prune local windows before applying any limits
      prune(ctx.rate.second, now - 1000);
      prune(ctx.rate.minute, now - 60_000);
      prune(ctx.rate.day, now - 86_400_000);

      // If the client is not yet authenticated, apply a strict default rate limit
      if (!ctx.apiKey || !ctx.tierLimits) {
        if (ctx.rate.second.timestamps.length >= UNAUTH_RPS) return false;
        if (ctx.rate.minute.timestamps.length >= UNAUTH_RPM) return false;
        if (ctx.rate.day.timestamps.length >= UNAUTH_RPD) return false;

        ctx.rate.second.timestamps.push(now);
        ctx.rate.minute.timestamps.push(now);
        ctx.rate.day.timestamps.push(now);
        return true;
      }

      if (ctx.tierLimits.rps <= 0 || ctx.tierLimits.rpm <= 0 || ctx.tierLimits.rpd <= 0) {
        return false;
      }

      const shared = await getSharedRateLimitForCtx();
      if (shared) {
        if (shared.rps > ctx.tierLimits.rps) return false;
        if (shared.rpm > ctx.tierLimits.rpm) return false;
        if (shared.rpd > ctx.tierLimits.rpd) return false;
        return true;
      }

      const { rps, rpm, rpd } = ctx.tierLimits;
      if (ctx.rate.second.timestamps.length >= rps) return false;
      if (ctx.rate.minute.timestamps.length >= rpm) return false;
      if (ctx.rate.day.timestamps.length >= rpd) return false;
      ctx.rate.second.timestamps.push(now);
      ctx.rate.minute.timestamps.push(now);
      ctx.rate.day.timestamps.push(now);
      return true;
    };

    ws.on('message', async (raw: ArrayBuffer | string, isBinary: boolean) => {
      let payload: IncomingMessage;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
        payload = JSON.parse(text) as IncomingMessage;
      } catch {
        return send({ type: 'error', code: 'bad_json', message: 'Invalid JSON payload' });
      }

      const allowed = await rateCheck();
      if (!allowed) {
        return send({ type: 'error', code: 'rate_limited', message: 'Rate limit exceeded' });
      }

      switch (payload.type) {
        case 'ping':
          return send({ type: 'pong' });
        case 'auth': {
          if (ctx.authenticated) return send({ type: 'auth.ok', already: true });
          const apiKey = normalizeApiKey(typeof payload.apiKey === 'string' ? payload.apiKey : null);
          if (!apiKey) return send({ type: 'error', code: 'auth', message: 'apiKey required' });
          try {
            const validation = await validateApiKeyAndUsage(apiKey);
            if (!validation.valid || !validation.userData || !validation.tierLimits) {
              return send({ type: 'error', code: 'auth', message: validation.error || 'Invalid key' });
            }
            ctx.apiKey = apiKey;
            ctx.userId = validation.userData.userId;
            ctx.tierLimits = validation.tierLimits;
            ctx.authenticated = true;
            return send({ type: 'auth.ok', tier: validation.userData.tier, role: validation.userData.role });
          } catch (err) {
            const error = err as Error;
            await logError({ message: 'WS auth error', errorMessage: error.message, errorStack: error.stack });
            return send({ type: 'error', code: 'auth', message: 'Internal auth error' });
          }
        }
        case 'chat.completions': {
          if (!ctx.authenticated || !ctx.apiKey) return send({ type: 'error', code: 'auth_required', message: 'Authenticate first' });
          const { model, messages, requestId, stream } = payload;
          if (!model || !messages || !Array.isArray(messages) || messages.length === 0) {
            return send({ type: 'error', code: 'bad_request', message: 'model and messages[] required', requestId });
          }
          const userMessage = messages[messages.length - 1];
          const content = userMessage?.content;
          if (typeof content !== 'string' && !Array.isArray(content)) {
            return send({ type: 'error', code: 'bad_request', message: 'Last message content must be string or array', requestId });
          }
          if (Array.isArray(content)) {
            const allItemsValid = content.every((item) => {
              if (!item || typeof item !== 'object') return false;
              const contentItem = item as { type?: unknown; text?: unknown };
              if (typeof contentItem.type !== 'string') return false;
              if (contentItem.type === 'text' && typeof contentItem.text !== 'string') return false;
              return true;
            });
            if (!allItemsValid) {
              return send({
                type: 'error',
                code: 'bad_request',
                message: 'Last message content array contains invalid items',
                requestId,
              });
            }
          }
          // Prefer the more explicit `reasoning_effort` field when present; fall back to
          // the legacy/general `reasoning` field for backward compatibility.
          const normalizedReasoning =
            payload.reasoning_effort !== undefined
              ? payload.reasoning_effort
              : payload.reasoning;
          const sharedMessageOptions = {
            tools: Array.isArray(payload.tools) ? payload.tools : undefined,
            tool_choice: payload.tool_choice,
            reasoning: normalizedReasoning,
          };
          const formattedMessages: WsChatMessage[] = messages.map((msg) => ({
            role: msg.role,
            content: msg.content as WsChatMessage['content'],
            model: { id: model },
            ...sharedMessageOptions,
          }));

          const started = Date.now();
          send({ type: 'chat.start', requestId });

          if (stream) {
            try {
              const streamHandler = messageHandler.handleStreamingMessages(formattedMessages, model, ctx.apiKey, { requestId });

              let totalTokenUsage = 0;
              let providerId: string | undefined;
              let toolCalls: ToolCall[] | undefined;
              let finishReason: string | undefined;

              const accumulateToolCalls = (calls: ToolCall[]) => {
                if (!toolCalls) {
                  toolCalls = [...calls];
                } else {
                  toolCalls.push(...calls);
                }
              };

              for await (const result of streamHandler) {
                if (result.type === 'chunk') {
                  // Accumulate any tool calls observed in streaming chunks so complex
                  // tool_call sequences are preserved for the final summary.
                  if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
                    accumulateToolCalls(result.tool_calls);
                  }
                  // Track latest finish_reason observed during streaming.
                  if (result.finish_reason) {
                    finishReason = result.finish_reason;
                  }

                  const openaiStreamChunk: OpenAIStreamChunk = {
                    id: `chatcmpl-${requestId || Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: {
                        content: result.chunk,
                        ...(result.tool_calls && result.tool_calls.length > 0 ? { tool_calls: result.tool_calls } : {}),
                      },
                      finish_reason: result.finish_reason || null,
                    }]
                  };
                  send(openaiStreamChunk);
                } else if (result.type === 'final') {
                  if (typeof result.tokenUsage === 'number') totalTokenUsage = result.tokenUsage;
                  if (result.providerId) providerId = result.providerId;
                  if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
                    accumulateToolCalls(result.tool_calls);
                  }
                  if (result.finish_reason) finishReason = result.finish_reason;
                }
              }

              try {
                await updateUserTokenUsage(totalTokenUsage, ctx.apiKey);
              } catch (updateErr) {
                // Log usage update failures but do not block the response to the client.
                // Avoid logging the full API key; only include a masked suffix for correlation.
                const redactedApiKey = ctx.apiKey ? `***${ctx.apiKey.slice(-4)}` : undefined;
                await logError({
                  message: 'Failed to update user token usage in WebSocket handler',
                  apiKey: redactedApiKey,
                  totalTokenUsage,
                  requestId,
                  error: updateErr
                });
              }

              const finalPayload: ChatCompleteResponse = {
                type: 'chat.complete',
                requestId,
                response: {
                  id: `chatcmpl-${requestId || Date.now()}`,
                  object: 'chat.completion',
                  created: Math.floor(started / 1000),
                  model,
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: '',
                      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                    },
                    finish_reason: finishReason || (toolCalls?.length ? 'tool_calls' : 'stop'),
                  }],
                  usage: { total_tokens: totalTokenUsage }
                },
                latencyMs: Date.now() - started,
                providerId
              };
              return send(finalPayload);
            } catch (err) {
              const error = err as Error;
              await logError({ message: 'WS stream error', errorMessage: error.message, errorStack: error.stack });
              return send({ type: 'error', code: 'stream_error', message: error.message || 'Stream failed', requestId });
            }
          }

          try {
            const result: MessageResult = await messageHandler.handleMessages(formattedMessages, model, ctx.apiKey, requestId);
            const totalTokens = typeof result.tokenUsage === 'number' ? result.tokenUsage : estimateTokens(result.response || '');
            await updateUserTokenUsage(totalTokens, ctx.apiKey);

            const openaiResponse: OpenAIResponse = {
              id: `chatcmpl-${requestId || Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: result.response,
                  ...(result.tool_calls && result.tool_calls.length > 0 ? { tool_calls: result.tool_calls } : {}),
                },
                finish_reason: result.finish_reason || (result.tool_calls?.length ? 'tool_calls' : 'stop'),
              }],
              usage: { total_tokens: totalTokens }
            };

            const response: ChatCompleteResponse = {
              type: 'chat.complete',
              requestId,
              response: openaiResponse,
              latencyMs: Date.now() - started,
              providerId: result.providerId
            };
            return send(response);
          } catch (err) {
            const error = err as Error;
            await logError({ message: 'WS message error', errorMessage: error.message, errorStack: error.stack });
            return send({ type: 'error', code: 'internal', message: 'Processing error', requestId });
          }
        }
        default:
          return send({ type: 'error', code: 'unknown_type', message: 'Unknown message type' });
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });

    wsClients.add(ws);
  });
}

export { publishWsBroadcast };
