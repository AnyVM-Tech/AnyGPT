import crypto from 'crypto';
import { dataManager, LoadedProviders, LoadedProviderData } from './dataManager.js';
import { fetchWithTimeout } from './http.js';

export type InteractionRequest = {
    model: string;
    input: string;
    tools?: any[];
    response_format?: any;
    generation_config?: any;
    agent?: string;
};

export type InteractionTokenClient = 'gemini' | 'openai-chat' | 'openai-responses';

export type InteractionTokenPayload = {
    v: 1;
    exp: number;
    apiKeyHash: string;
    request: InteractionRequest;
    client: InteractionTokenClient;
    display_model?: string;
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function base64UrlEncode(input: Buffer | string): string {
    const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    return raw.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64');
}

function hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function getInteractionsSigningSecret(): string {
    const secret = process.env.INTERACTIONS_SIGNING_SECRET;
    if (!secret || !secret.trim()) {
        throw new Error('Missing INTERACTIONS_SIGNING_SECRET for interactions polling.');
    }
    return secret;
}

export function normalizeDeepResearchModel(model: string, agent?: string): { model: string; agent?: string } {
    const prefix = 'deep-research-';
    if (typeof model === 'string' && model.toLowerCase().startsWith(prefix)) {
        const normalized = model.slice(prefix.length);
        return { model: normalized, agent: agent || 'deep-research' };
    }
    return { model, agent };
}

export function createInteractionToken(
    request: InteractionRequest,
    apiKey: string,
    client: InteractionTokenClient,
    ttlSeconds: number,
    secret: string,
    displayModel?: string
): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload: InteractionTokenPayload = {
        v: 1,
        exp,
        apiKeyHash: hashApiKey(apiKey),
        request,
        client,
        display_model: displayModel,
    };
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
    const signatureB64 = signature.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${payloadB64}.${signatureB64}`;
}

export function verifyInteractionToken(token: string, apiKey: string, secret: string): InteractionTokenPayload {
    const parts = token.split('.');
    if (parts.length !== 2) {
        throw new Error('Invalid interaction_id token format.');
    }
    const [payloadB64, signatureB64] = parts;
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (!crypto.timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expected))) {
        throw new Error('Invalid interaction_id signature.');
    }
    const payloadJson = base64UrlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadJson) as InteractionTokenPayload;
    if (payload.v !== 1) {
        throw new Error('Unsupported interaction_id token version.');
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
        throw new Error('interaction_id token expired.');
    }
    if (payload.apiKeyHash !== hashApiKey(apiKey)) {
        throw new Error('interaction_id token does not match API key.');
    }
    return payload;
}

export function extractOpenAIResponseFormat(responseFormat: any): any | undefined {
    if (!responseFormat || typeof responseFormat !== 'object') return undefined;

    if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
        return responseFormat.json_schema.schema;
    }

    if (typeof responseFormat.type === 'string' && responseFormat.type !== 'json_schema') {
        return undefined;
    }

    if (responseFormat.type && responseFormat.properties) {
        return responseFormat;
    }

    return undefined;
}

export async function pickGeminiProviderKey(): Promise<string> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const candidates = providers.filter((p: LoadedProviderData) =>
        !p.disabled &&
        (p.id.includes('gemini') || p.id === 'google') &&
        p.apiKey
    );
    if (candidates.length === 0) {
        const fallback = providers.find((p: LoadedProviderData) =>
            !p.disabled && (p.id.includes('gemini') || p.id === 'google') && p.apiKey
        );
        if (!fallback || !fallback.apiKey) {
            throw new Error('No configured Gemini provider API key available.');
        }
        return fallback.apiKey;
    }
    return candidates[Math.floor(Math.random() * candidates.length)].apiKey!;
}

export async function executeGeminiInteraction(request: InteractionRequest, providerApiKey?: string): Promise<any> {
    const apiKey = providerApiKey || await pickGeminiProviderKey();
    const body: Record<string, any> = {
        model: request.model,
        input: request.input,
    };

    if (Array.isArray(request.tools) && request.tools.length > 0) {
        body.tools = request.tools;
    }
    if (request.response_format && typeof request.response_format === 'object') {
        body.response_format = request.response_format;
    }
    if (request.generation_config && typeof request.generation_config === 'object') {
        body.generation_config = request.generation_config;
    }

    const response = await fetchWithTimeout(`${GEMINI_API_BASE}/interactions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Gemini Interactions API failed: [${response.status} ${response.statusText}] ${errorText}`);
    }

    return response.json();
}
