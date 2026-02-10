import { RequestContext, WSWrapper } from '../lib/uws-compat.js';
import { messageHandler } from '../providers/handler.js';
import { validateApiKeyAndUsage, updateUserTokenUsage } from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js';

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

interface WsClientContext {
  apiKey?: string;
  userId?: string;
  tierLimits?: TierLimits;
  rate: { second: RateWindow; minute: RateWindow; day: RateWindow };
  authenticated: boolean;
}

interface TierLimits { rps: number; rpm: number; rpd: number; }

interface BaseMessage { type: string; }
interface PingMessage extends BaseMessage { type: 'ping'; }
interface AuthMessage extends BaseMessage { type: 'auth'; apiKey: string; }
interface ChatCompletionsMessage extends BaseMessage {
  type: 'chat.completions';
  model: string;
  messages: Array<{ role: string; content: string }>;
  requestId?: string;
  stream?: boolean;
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
  choices: Array<{ index: number; delta: { content?: string }; finish_reason: string | null }>;
}
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
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
}

function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function prune(window: RateWindow, cutoff: number): void { window.timestamps = window.timestamps.filter(ts => ts >= cutoff); }

export function attachWebSocket(app: { ws: (path: string, handler: (ws: WSWrapper, req: RequestContext) => void) => void }) {
  app.ws('/ws', (ws: WSWrapper, req: RequestContext) => {
    const ctx: WsClientContext = {
      rate: { second: { timestamps: [] }, minute: { timestamps: [] }, day: { timestamps: [] } },
      authenticated: false
    };

    const send = (data: OutgoingResponse): void => {
      try { ws.send(JSON.stringify(data)); } catch { /* ignore */ }
    };

    const rateCheck = (): boolean => {
      if (!ctx.apiKey || !ctx.tierLimits) return true; // until auth completes
      const now = Date.now();
      prune(ctx.rate.second, now - 1000);
      prune(ctx.rate.minute, now - 60_000);
      prune(ctx.rate.day, now - 86_400_000);

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

      if (!rateCheck()) {
        return send({ type: 'error', code: 'rate_limited', message: 'Rate limit exceeded' });
      }

      switch (payload.type) {
        case 'ping':
          return send({ type: 'pong' });
        case 'auth': {
          if (ctx.authenticated) return send({ type: 'auth.ok', already: true });
          const apiKey = payload.apiKey;
          if (!apiKey || typeof apiKey !== 'string') return send({ type: 'error', code: 'auth', message: 'apiKey required' });
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
          if (typeof content !== 'string') {
            return send({ type: 'error', code: 'bad_request', message: 'Last message content must be string', requestId });
          }

          const started = Date.now();
          send({ type: 'chat.start', requestId });

          if (stream) {
            try {
              const streamHandler = messageHandler.handleStreamingMessages([{ content, model: { id: model } } as any], model, ctx.apiKey);

              let totalTokenUsage = 0;
              let providerId: string | undefined;

              for await (const result of streamHandler) {
                if (result.type === 'chunk') {
                  const openaiStreamChunk: OpenAIStreamChunk = {
                    id: `chatcmpl-${requestId || Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model,
                    choices: [{ index: 0, delta: { content: result.chunk }, finish_reason: null }]
                  };
                  send(openaiStreamChunk);
                } else if (result.type === 'final') {
                  if (typeof result.tokenUsage === 'number') totalTokenUsage = result.tokenUsage;
                  if (result.providerId) providerId = result.providerId;
                }
              }

              if (totalTokenUsage > 0) {
                await updateUserTokenUsage(totalTokenUsage, ctx.apiKey);
              }

              const finalPayload: ChatCompleteResponse = {
                type: 'chat.complete',
                requestId,
                response: {
                  id: `chatcmpl-${requestId || Date.now()}`,
                  object: 'chat.completion',
                  created: Math.floor(started / 1000),
                  model,
                  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
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
            const result: MessageResult = await messageHandler.handleMessages([{ content, model: { id: model } } as any], model, ctx.apiKey);
            const totalTokens = typeof result.tokenUsage === 'number' ? result.tokenUsage : estimateTokens(result.response || '');
            if (totalTokens > 0) await updateUserTokenUsage(totalTokens, ctx.apiKey);

            const openaiResponse: OpenAIResponse = {
              id: `chatcmpl-${requestId || Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: result.response }, finish_reason: 'stop' }],
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
      // Placeholder for cleanup if needed later
    });
  });
}
