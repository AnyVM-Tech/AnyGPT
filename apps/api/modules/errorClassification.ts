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
