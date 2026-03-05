/**
 * Shared error classification utilities.
 *
 * Centralises the error-type detection logic that was previously duplicated
 * across providers/handler.ts and routes/openai.ts.
 */

// --- Rate-limit / Quota ---

export function isRateLimitOrQuotaError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;
    return (
        message.includes('rate limit') ||
        message.includes('rate_limit') ||
        message.includes('resource_exhausted') ||
        message.includes('quota exceeded') ||
        message.includes('too many requests') ||
        message.includes('status 429') ||
        message.includes(' 429 ')
    );
}

// --- Retry-After ---

/**
 * Parses a retry-after duration from an error message.
 * Returns the value in milliseconds, or null if none found.
 */
export function extractRetryAfterMs(message: string): number | null {
    if (!message) return null;
    const retryDelayMatch = message.match(/retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/i);
    if (retryDelayMatch) {
        const parsed = Number.parseFloat(retryDelayMatch[1]);
        if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed * 1000);
    }
    const retryInMatch = message.match(/retry in ([0-9]+(?:\.[0-9]+)?)s/i);
    if (retryInMatch) {
        const parsed = Number.parseFloat(retryInMatch[1]);
        if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed * 1000);
    }
    return null;
}

/**
 * Same as extractRetryAfterMs but returns whole seconds (for HTTP Retry-After header).
 */
export function extractRetryAfterSeconds(message: string): number | null {
    const ms = extractRetryAfterMs(message);
    if (ms === null) return null;
    return Math.max(1, Math.ceil(ms / 1000));
}

// --- Rate Limit RPS ---

function toRps(value: number, unit: 'rps' | 'rpm' | 'rpd'): number {
    if (unit === 'rps') return value;
    if (unit === 'rpm') return value / 60;
    return value / 86400;
}

function parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function windowUnitToSeconds(unit: string): number | null {
    const normalized = unit.toLowerCase();
    if (['s', 'sec', 'secs', 'second', 'seconds'].includes(normalized)) return 1;
    if (['m', 'min', 'mins', 'minute', 'minutes'].includes(normalized)) return 60;
    if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(normalized)) return 3600;
    if (['d', 'day', 'days'].includes(normalized)) return 86400;
    return null;
}

/**
 * Extract an explicit rate limit (requests per second) from an error message.
 * Returns null if no explicit limit is found.
 */
export function extractRateLimitRps(message: string): number | null {
    if (!message) return null;
    const sanitized = String(message).replace(/,/g, '');

    const directPatterns: Array<{ regex: RegExp; unit: 'rps' | 'rpm' | 'rpd' }> = [
        { regex: /(\d+(?:\.\d+)?)\s*(?:rps|reqs?\/s|requests?\/s|requests?\s*per\s*second)\b/i, unit: 'rps' },
        { regex: /(\d+(?:\.\d+)?)\s*(?:rpm|reqs?\/m|requests?\/m|requests?\s*per\s*minute)\b/i, unit: 'rpm' },
        { regex: /(\d+(?:\.\d+)?)\s*(?:rpd|requests?\s*per\s*day)\b/i, unit: 'rpd' },
    ];

    for (const { regex, unit } of directPatterns) {
        const match = sanitized.match(regex);
        const numeric = parseNumber(match?.[1]);
        if (numeric !== null) return toRps(numeric, unit);
    }

    const windowMatch = sanitized.match(/(\d+(?:\.\d+)?)\s*requests?\s*(?:in|per)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i);
    if (windowMatch) {
        const count = parseNumber(windowMatch[1]);
        const span = parseNumber(windowMatch[2]);
        const secondsPerUnit = windowUnitToSeconds(windowMatch[3]);
        if (count !== null && span !== null && secondsPerUnit !== null) {
            const totalSeconds = span * secondsPerUnit;
            if (totalSeconds > 0) return count / totalSeconds;
        }
    }

    return null;
}

// --- Insufficient Credits ---

export function isInsufficientCreditsError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;
    return (
        message.includes('requires more credits') ||
        message.includes('insufficient credits') ||
        message.includes('can only afford') ||
        message.includes('payment required') ||
        message.includes('status 402')
    );
}

// --- Invalid Credentials ---

export function isInvalidProviderCredentialError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;
    return (
        message.includes('api_key_invalid') ||
        message.includes('api key not found') ||
        message.includes('invalid api key') ||
        message.includes('invalid authentication') ||
        message.includes('incorrect api key') ||
        message.includes('unauthorized')
    );
}

// --- Model Access ---

export function isModelAccessError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    return (
        message.includes('does not have access to model') ||
        message.includes('model_not_found') ||
        message.includes('no gemini model available') ||
        message.includes('no eligible image models found') ||
        message.includes('not found for api version') ||
        message.includes('model not found') ||
        message.includes('the model') && message.includes('does not exist') ||
        message.includes('is not available') && message.includes('model') ||
        message.includes('not supported for this model') ||
        message.includes('model is not accessible') ||
        message.includes('you do not have access') ||
        message.includes('permission denied') && message.includes('model')
    );
}

// --- Tool Unsupported ---

export function isToolUnsupportedError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;

    const patterns = [
        "unsupported parameter: 'tools'",
        'unsupported parameter: "tools"',
        "unsupported parameter: 'tool_choice'",
        'unsupported parameter: "tool_choice"',
        "unknown parameter: 'tools'",
        'unknown parameter: "tools"',
        "unknown parameter: 'tool_choice'",
        'unknown parameter: "tool_choice"',
        'tool calls are not supported',
        'tool call is not supported',
        'tool calling is not supported',
        'tool_calls is not supported',
        'tool_choice is not supported',
        'tools are not supported',
        'tools is not supported',
        'tools not supported',
        'does not support tools',
        'does not support tool',
        'function calling is not supported',
        'function_call is not supported',
    ];

    if (patterns.some((pattern) => message.includes(pattern))) return true;
    if (message.includes('tools') && message.includes('not supported')) return true;
    return false;
}
