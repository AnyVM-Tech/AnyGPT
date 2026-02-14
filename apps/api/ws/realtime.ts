import { WSWrapper, RequestContext } from '../lib/uws-compat.js';
import NodeWebSocket from 'ws';
import { validateApiKeyAndUsage, updateUserTokenUsage } from '../modules/userData.js';
import { dataManager, LoadedProviders, LoadedProviderData } from '../modules/dataManager.js';
import { logError } from '../modules/errorLogger.js';

interface RealtimeConfig {
    url: string;
    apiKey: string;
    model: string;
}

async function pickRealtimeProvider(modelId: string): Promise<RealtimeConfig | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    // Prioritize providers that explicitly list the model
    const candidates = providers.filter((p: LoadedProviderData) => 
        !p.disabled && 
        p.apiKey && 
        (p.id.includes('openai') || p.provider_url?.includes('api.openai.com')) &&
        (p.models && modelId in p.models)
    );

    let selected: LoadedProviderData | undefined;
    if (candidates.length > 0) {
        selected = candidates[Math.floor(Math.random() * candidates.length)];
    } else {
        // Fallback: any valid OpenAI provider (assuming they might support it even if not listed)
        const fallbacks = providers.filter((p: LoadedProviderData) => 
            !p.disabled && 
            p.apiKey && 
            (p.id.includes('openai') || p.provider_url?.includes('api.openai.com'))
        );
        if (fallbacks.length > 0) {
            selected = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
    }

    if (!selected || !selected.apiKey) return null;

    // Construct Realtime API URL
    // Standard OpenAI: wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01
    // We handle the model param separately
    let baseUrl = 'wss://api.openai.com/v1/realtime';
    
    // Attempt to respect provider_url overrides if they seem compatible with WS
    // E.g. if provider_url is https://api.openai.com/v1/chat/completions -> wss://api.openai.com/v1/realtime
    if (selected.provider_url) {
        try {
            const u = new URL(selected.provider_url);
            if (u.hostname.includes('openai.com')) {
                // If it's a standard OpenAI host, enforce wss protocol and /v1/realtime path
                baseUrl = `wss://${u.hostname}/v1/realtime`;
            } else {
                // For custom proxies, we might need to trust their URL or adapt it.
                // Assuming standard OpenAI compatible proxies:
                baseUrl = selected.provider_url.replace(/^http/, 'ws').replace(/\/chat\/completions$/, '/realtime');
            }
        } catch { /* ignore invalid URLs */ }
    }

    return {
        url: `${baseUrl}?model=${modelId}`,
        apiKey: selected.apiKey,
        model: modelId
    };
}

export function attachRealtimeWebSocket(app: { ws: (path: string, handler: (ws: WSWrapper, req: RequestContext) => void) => void }) {
    app.ws('/v1/realtime', (clientWs: WSWrapper, req: RequestContext) => {
        let upstreamWs: any = null;
        let isAuthenticated = false;
        let userId: string | null = null;
        let userApiKey: string | null = null;
        let messageBuffer: any[] = []; // Buffer messages until upstream connects

        // 1. Authenticate Client
        // Query param 'api-key' or Header 'Authorization' (or 'api-key')
        // Note: uWS RequestContext headers are lowercase
        const authHeader = req.headers['authorization'] || req.headers['api-key'];
        const queryApiKey = (req.query['api-key'] as string) || (req.query['apikey'] as string);
        let apiKeyCandidate = '';

        if (authHeader) {
            if (authHeader.startsWith('Bearer ')) apiKeyCandidate = authHeader.slice(7);
            else apiKeyCandidate = authHeader;
        } else if (queryApiKey) {
            apiKeyCandidate = queryApiKey;
        }

        // 2. Validate Key
        const validationPromise = (async () => {
            if (!apiKeyCandidate) {
                clientWs.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing API key.' } }));
                clientWs.close();
                return false;
            }

            const validation = await validateApiKeyAndUsage(apiKeyCandidate);
            if (!validation.valid || !validation.userData) {
                clientWs.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid API key.' } }));
                clientWs.close();
                return false;
            }
            isAuthenticated = true;
            userId = validation.userData.userId;
            userApiKey = apiKeyCandidate;
            return true;
        })();

        // 3. Connect Upstream
        const connectPromise = validationPromise.then(async (valid) => {
            if (!valid) return;

            const modelId = (req.query['model'] as string);
            if (!modelId) {
                 clientWs.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Model parameter is required.' } }));
                 clientWs.close();
                 return;
            }

            const config = await pickRealtimeProvider(modelId);

            if (!config) {
                clientWs.send(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'No available provider for Realtime API.' } }));
                clientWs.close();
                return;
            }

            try {
                // Use 'any' cast to bypass strict DOM WebSocket constructor checks
                upstreamWs = new (NodeWebSocket as any)(config.url, {
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'OpenAI-Beta': 'realtime=v1',
                    }
                });

                (upstreamWs as any).on('open', () => {
                    // Flush buffer
                    for (const msg of messageBuffer) {
                        (upstreamWs as any)?.send(msg);
                    }
                    messageBuffer = [];
                });

                (upstreamWs as any).on('message', async (data: any) => {
                    // Forward to client
                    // uWS send expects string or ArrayBuffer
                    // WebSocket data is Buffer | ArrayBuffer | Buffer[]
                    // Convert to format uWS likes
                    let payload: any = data;
                    if (Buffer.isBuffer(data)) {
                        // Pass buffer directly? uWS wrapper handles string/ArrayBuffer.
                        // Buffer is Uint8Array which is ArrayBufferView.
                        // We might need to copy to ArrayBuffer or pass as is if compatible.
                        // Let's convert to string if it's JSON text, or pass binary.
                        // Realtime API is JSON based, but audio might be binary?
                        // Actually, Realtime API uses JSON messages with base64 audio.
                        // So data is likely text.
                        const text = data.toString('utf8');
                        try {
                            const event = JSON.parse(text);
                            // Track usage
                            if (event.type === 'response.done' && event.response?.usage) {
                                const usage = event.response.usage;
                                const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
                                if (total > 0 && userApiKey) {
                                    updateUserTokenUsage(total, userApiKey).catch(err => console.error('Realtime usage update failed', err));
                                }
                            }
                        } catch { /* ignore parse error for usage tracking */ }
                        
                        clientWs.send(text); // Forward as text
                    } else {
                        // Forward binary as-is (unlikely for Realtime API v1)
                         // clientWs.send(data); // Types might mismatch
                         // Fallback to string
                         clientWs.send(data.toString());
                    }
                });

                (upstreamWs as any).on('error', (err: any) => {
                    console.error('Realtime Upstream Error:', err);
                    clientWs.send(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'Upstream connection error.' } }));
                    clientWs.close();
                });

                (upstreamWs as any).on('close', () => {
                    clientWs.close();
                });

            } catch (err: any) {
                console.error('Realtime Connection Setup Error:', err);
                clientWs.send(JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'Failed to connect to provider.' } }));
                clientWs.close();
            }
        });

        clientWs.on('message', (msg: ArrayBuffer | string, isBinary: boolean) => {
            if (!isAuthenticated) {
                // Buffer until auth & connection ready
                if (typeof msg === 'string') {
                    messageBuffer.push(Buffer.from(msg));
                } else {
                    messageBuffer.push(msg);
                }
                return;
            }

            if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
                upstreamWs.send(msg);
            } else {
                // Buffer or drop?
                // If upstream is connecting, buffer.
                if (typeof msg === 'string') {
                    messageBuffer.push(Buffer.from(msg));
                } else {
                    messageBuffer.push(msg);
                }
            }
        });

        clientWs.on('close', () => {
            if (upstreamWs) {
                if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
                    upstreamWs.close();
                }
            }
        });
    });
}
