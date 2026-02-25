/**
 * Shared token estimation utilities.
 *
 * Centralises the token-counting heuristics that were previously duplicated
 * across providers/handler.ts and routes/openai.ts.
 */
import type { IMessage } from '../providers/interfaces.js';

// --- Environment Utilities ---

export function readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function readEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

export function readEnvCsv(name: string): string[] | null {
    const raw = process.env[name];
    if (!raw) return null;
    const items = raw.split(',').map((item: string) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
}

// --- Token Estimation Constants ---

export const BASE64_DATA_URL_GLOBAL = /data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)/gi;

export const IMAGE_INPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_INPUT_TOKENS_PER_KB', 4);
export const IMAGE_OUTPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_OUTPUT_TOKENS_PER_KB', 8);
export const AUDIO_INPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_INPUT_TOKENS_PER_KB', 2);
export const AUDIO_OUTPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_OUTPUT_TOKENS_PER_KB', 4);
export const IMAGE_URL_FALLBACK_TOKENS = readEnvNumber('IMAGE_URL_FALLBACK_TOKENS', 512);
export const AUDIO_DATA_FALLBACK_TOKENS = readEnvNumber('AUDIO_DATA_FALLBACK_TOKENS', 256);
export const IMAGE_MIN_TOKENS = readEnvNumber('IMAGE_MIN_TOKENS', 0);
export const AUDIO_MIN_TOKENS = readEnvNumber('AUDIO_MIN_TOKENS', 0);

// --- Types ---

export type TokenBreakdown = {
    total: number;
    textTokens: number;
    imageTokens: number;
    audioTokens: number;
};

// --- Functions ---

export function estimateTokensFromBase64Payload(payload: string, tokensPerKb: number, minTokens: number): number {
    if (!payload) return minTokens;
    const cleaned = payload.replace(/\s+/g, '');
    if (!cleaned) return minTokens;
    const bytes = Math.max(0, Math.floor((cleaned.length * 3) / 4));
    const tokens = Math.ceil((bytes / 1024) * tokensPerKb);
    return Math.max(tokens, minTokens);
}

export function estimateTokensFromDataUrl(dataUrl: string, direction: 'input' | 'output'): number {
    const match = dataUrl.match(/^data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
    if (!match) return 0;
    const mimeType = (match[1] || '').toLowerCase();
    const payload = match[2] || '';

    if (mimeType.startsWith('image/')) {
        const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
    }
    if (mimeType.startsWith('audio/')) {
        const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
    }
    return 0;
}

export function estimateTokensFromTextBreakdown(text: string, direction: 'input' | 'output' = 'output'): TokenBreakdown {
    const value = String(text || '');
    if (!value) {
        return { total: 0, textTokens: 0, imageTokens: 0, audioTokens: 0 };
    }

    let imageTokens = 0;
    let audioTokens = 0;
    if (value.includes('data:')) {
        const regex = new RegExp(BASE64_DATA_URL_GLOBAL);
        for (const match of value.matchAll(regex)) {
            const mimeType = (match[1] || '').toLowerCase();
            const payload = match[2] || '';
            if (mimeType.startsWith('image/')) {
                const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
                imageTokens += estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
            } else if (mimeType.startsWith('audio/')) {
                const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
                audioTokens += estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
            }
        }
    }

    const stripped = value.replace(BASE64_DATA_URL_GLOBAL, '[binary-data]');
    const textTokens = stripped ? Math.ceil(stripped.length / 4) : 0;
    const total = textTokens + imageTokens + audioTokens;
    return { total, textTokens, imageTokens, audioTokens };
}

export function estimateTokensFromText(text: string, direction: 'input' | 'output' = 'output'): number {
    return estimateTokensFromTextBreakdown(text, direction).total;
}

export function estimateTokensFromContentBreakdown(content: IMessage['content']): TokenBreakdown {
    if (typeof content === 'string') {
        return estimateTokensFromTextBreakdown(content, 'input');
    }
    if (!Array.isArray(content)) {
        return estimateTokensFromTextBreakdown(JSON.stringify(content), 'input');
    }

    let textTokens = 0;
    let imageTokens = 0;
    let audioTokens = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = String((part as any).type || '').toLowerCase();
        if (type === 'text' || type === 'input_text') {
            const breakdown = estimateTokensFromTextBreakdown((part as any).text || '', 'input');
            textTokens += breakdown.textTokens;
            imageTokens += breakdown.imageTokens;
            audioTokens += breakdown.audioTokens;
            continue;
        }
        if (type === 'image_url' || type === 'input_image') {
            const url = (part as any)?.image_url?.url
                || (part as any)?.image_url
                || (part as any)?.url
                || (part as any)?.image?.url;
            if (typeof url === 'string' && url.startsWith('data:')) {
                const match = url.match(/^data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
                if (match) {
                    const mimeType = (match[1] || '').toLowerCase();
                    const payload = match[2] || '';
                    if (mimeType.startsWith('image/')) {
                        imageTokens += estimateTokensFromBase64Payload(payload, IMAGE_INPUT_TOKENS_PER_KB, IMAGE_MIN_TOKENS);
                    } else if (mimeType.startsWith('audio/')) {
                        audioTokens += estimateTokensFromBase64Payload(payload, AUDIO_INPUT_TOKENS_PER_KB, AUDIO_MIN_TOKENS);
                    } else {
                        textTokens += estimateTokensFromDataUrl(url, 'input');
                    }
                }
            } else if (typeof url === 'string' && url.length > 0) {
                imageTokens += IMAGE_URL_FALLBACK_TOKENS;
            }
            continue;
        }
        if (type === 'input_audio' || type === 'audio') {
            const data = (part as any)?.input_audio?.data
                || (part as any)?.audio?.data
                || (part as any)?.data;
            if (typeof data === 'string' && data.length > 0) {
                audioTokens += estimateTokensFromBase64Payload(data, AUDIO_INPUT_TOKENS_PER_KB, AUDIO_MIN_TOKENS);
            } else {
                audioTokens += AUDIO_DATA_FALLBACK_TOKENS;
            }
            continue;
        }
        const fallback = estimateTokensFromTextBreakdown(JSON.stringify(part), 'input');
        textTokens += fallback.textTokens;
        imageTokens += fallback.imageTokens;
        audioTokens += fallback.audioTokens;
    }

    const total = textTokens + imageTokens + audioTokens;
    return { total, textTokens, imageTokens, audioTokens };
}

export function estimateTokensFromContent(content: IMessage['content']): number {
    return estimateTokensFromContentBreakdown(content).total;
}

export function estimateTokensFromMessagesBreakdown(messages: IMessage[]): TokenBreakdown {
    const acc: TokenBreakdown = { total: 0, textTokens: 0, imageTokens: 0, audioTokens: 0 };
    for (const message of messages) {
        const breakdown = estimateTokensFromContentBreakdown(message.content);
        acc.total += breakdown.total;
        acc.textTokens += breakdown.textTokens;
        acc.imageTokens += breakdown.imageTokens;
        acc.audioTokens += breakdown.audioTokens;
    }
    return acc;
}
