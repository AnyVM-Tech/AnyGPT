import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import redis from '../modules/db.js'; // Import redis client
import type { Request } from '../lib/uws-compat.js';
import { logger } from './logger.js';
import { isInsufficientCreditsError, isModelAccessError, isInvalidApiKeyError } from './errorClassification.js';
import { hashToken, redactToken } from './redaction.js';

function sanitizeProviderErrorText(value: string): string {
	if (!value) return value;
	return value
		.replace(/\bsk(?:-proj)?-[A-Za-z0-9_*.-]{8,}\b/g, '[redacted-api-key]')
		.replace(/sk-proj-[A-Za-z0-9_*.-]{16,}/gi, '[redacted-api-key]')
		.replace(/sk-proj-[*A-Za-z0-9._-]{12,}/gi, '[redacted-api-key]')
		.replace(/sk-proj-[*A-Za-z0-9._-]+/gi, '[redacted-api-key]')
		.replace(/sk-proj-[^\s,;)'"\]}]+/gi, '[redacted-api-key]')
		.replace(/\bAIza[0-9A-Za-z\-_]{16,}\b/g, '[redacted-api-key]')
		.replace(/\b(?:api[_-]?key|authorization)\b\s*[:=]\s*(?:bearer\s+)?(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, (match) => {
			const separatorMatch = match.match(/[:=]/);
			const separator = separatorMatch ? separatorMatch[0] : ':';
			const label = match.toLowerCase().includes('authorization') ? 'authorization' : 'api_key';
			return `${label}${separator} [redacted]`;
		})
		.replace(/\bauthorization\b\s*[:=]\s*bearer\s+[A-Za-z0-9._\-]+/gi, 'authorization: [redacted]');
}

function sanitizeProviderErrorValue<T>(value: T): T {
	if (typeof value === 'string') {
		return sanitizeProviderErrorText(value) as T;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeProviderErrorValue(entry)) as T;
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				sanitizeProviderErrorValue(entry),
			])
		) as T;
	}
	return value;
}

const configuredLogDirectory = (process.env.ANYGPT_LOG_DIR || '').trim();
const logDirectory = configuredLogDirectory
	? path.resolve(configuredLogDirectory)
	: path.resolve(process.cwd(), 'logs');
const errorLogFilePath = path.join(logDirectory, 'api-errors.jsonl');
const providerUniqueErrorLogFilePath = path.join(logDirectory, 'provider-unique-errors.jsonl');

// Configuration from environment variables
const logToRedis = process.env.ERROR_LOG_TO_REDIS === 'true';
const redisLogKey = process.env.REDIS_ERROR_LOG_KEY || 'api:error_logs';
const redisMaxLogEntries = parseInt(process.env.REDIS_ERROR_LOG_MAX_ENTRIES || '1000', 10);
const providerUniqueRedisKey = process.env.REDIS_PROVIDER_UNIQUE_ERROR_KEY || 'api:provider_unique_error_fingerprints';

logger.debug(`[ErrorLogger] Current working directory: ${process.cwd()}`);
logger.debug(`[ErrorLogger] Log directory target: ${logDirectory}`);
logger.debug(`[ErrorLogger] Error log file path: ${errorLogFilePath}`);
logger.debug(`[ErrorLogger] Log to Redis enabled: ${logToRedis}`);
if (logToRedis) {
    logger.debug(`[ErrorLogger] Redis log key: ${redisLogKey}`);
    logger.debug(`[ErrorLogger] Redis max log entries: ${redisMaxLogEntries}`);
}

// Ensure log directory exists
if (!fs.existsSync(logDirectory)) {
    logger.debug(`[ErrorLogger] Log directory does not exist. Attempting to create: ${logDirectory}`);
    try {
        fs.mkdirSync(logDirectory, { recursive: true });
        logger.debug(`[ErrorLogger] Successfully created log directory: ${logDirectory}`);
    } catch (e: any) {
        logger.error(`[ErrorLogger] CRITICAL: Failed to create log directory: ${logDirectory}. Error: ${e.message}`, e);
    }
} else {
    logger.debug(`[ErrorLogger] Log directory already exists: ${logDirectory}`);
}

interface ErrorLogEntry {
    timestamp: string;
    errorId?: string;
    apiKey?: string;
    apiKeyHash?: string;
    originIp?: string;
    requestMethod?: string;
    requestUrl?: string;
    errorMessage: string;
    errorStack?: string;
    errorDetails?: any;
}

interface ProviderUniqueErrorLogEntry {
    timestamp: string;
    fingerprint: string;
    provider: string;
    operation: string;
    modelId?: string;
    endpoint?: string;
    latencyMs?: number;
    errorMessage: string;
    errorDetails?: any;
}

interface ProviderErrorLogContext {
    provider: string;
    operation: string;
    modelId?: string;
    endpoint?: string;
    latencyMs?: number;
    error: any;
    extra?: Record<string, any>;
}

type NormalizedErrorPayload = {
    message: string;
    stack?: string;
    details?: Record<string, any>;
};

const MAX_DETAIL_STRING_LENGTH = (() => {
    const raw = Number(process.env.ERROR_LOG_MAX_DETAIL_CHARS);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 4000;
})();

const MAX_DETAIL_KEYS = (() => {
    const raw = Number(process.env.ERROR_LOG_MAX_DETAIL_KEYS);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 60;
})();

const providerUniqueErrorFingerprints = new Set<string>();

loadExistingProviderUniqueErrorFingerprints();

const FINGERPRINT_OMIT_KEYS = new Set([
    'stack',
    'responseHeaders',
    'errorJson',
    'fingerprint',
    'timestamp',
]);

function sanitizeValue(value: any): any {
    if (typeof value === 'string') {
        if (MAX_DETAIL_STRING_LENGTH > 0 && value.length > MAX_DETAIL_STRING_LENGTH) {
            return `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…`;
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => sanitizeValue(entry));
    }
    if (value && typeof value === 'object') {
        return sanitizeDetails(value as Record<string, any>);
    }
    return value;
}

function sanitizeDetails(details: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    const entries = Object.entries(details).slice(0, MAX_DETAIL_KEYS > 0 ? MAX_DETAIL_KEYS : undefined);
    for (const [key, value] of entries) {
        if (value === undefined) continue; // Drop undefined values entirely
        const lowered = key.toLowerCase();
        if (['apikey', 'api_key', 'authorization', 'x-api-key', 'token', 'secret'].includes(lowered)) {
            sanitized[key] = typeof value === 'string' ? redactToken(value) : '[redacted]';
        } else if (value === null) {
            sanitized[key] = null; // Keep explicit nulls
        } else if (Array.isArray(value) && value.length === 0) {
            sanitized[key] = '(empty)'; // Make empty arrays visible
        } else {
            sanitized[key] = sanitizeValue(value);
        }
    }
    return sanitized;
}

function appendJsonLine(filePath: string, line: string): Promise<void> {
    return fs.promises.appendFile(filePath, `${line}\n`, 'utf8');
}

function normalizeFingerprintString(value: string): string {
    return String(value || '')
        .replace(/please retry in\s+[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|μs|ms|s|seconds?)\.?/gi, 'please retry in <retry>')
        .replace(/retry in\s+[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|μs|ms|s|seconds?)\.?/gi, 'retry in <retry>')
        .replace(/"retryDelay"\s*:\s*"[^"]+"/gi, '"retryDelay":"<retry>"')
        .replace(/"request_id"\s*:\s*"[^"]+"/gi, '"request_id":"<id>"')
        .replace(/"id"\s*:\s*"(?:chatcmpl|resp|msg|req|request)-?[^"]+"/gi, '"id":"<id>"')
        .replace(/\b(?:chatcmpl|resp|msg|req|request)-[a-z0-9._:-]+\b/gi, '<id>')
        .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '<id>')
        .replace(/\buser_[a-z0-9]+\b/gi, 'user_<id>')
        .replace(/latency\s+[0-9]+(?:\.[0-9]+)?ms/gi, 'latency <duration>')
        .replace(/\b[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|μs|ms|s)\b/gi, '<duration>')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeFingerprintValue(value: any, key?: string): any {
    if (typeof value === 'string') {
        return normalizeFingerprintString(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeFingerprintValue(entry));
    }
    if (value && typeof value === 'object') {
        const sorted: Record<string, any> = {};
        for (const entryKey of Object.keys(value).sort()) {
            if (FINGERPRINT_OMIT_KEYS.has(entryKey)) continue;
            if (entryKey === 'retryDelay') {
                sorted[entryKey] = '<retry>';
                continue;
            }
            sorted[entryKey] = normalizeFingerprintValue(value[entryKey], entryKey);
        }
        return sorted;
    }
    return value;
}

function normalizeProviderFingerprintKey(provider: string): string {
    const lower = String(provider || '').trim().toLowerCase();
    if (!lower) return lower;
    if (lower.includes('openrouter')) return 'openrouter';
    if (lower.includes('openai')) return 'openai';
    if (lower.includes('gemini') || lower.includes('google') || lower.includes('imagen') || lower.includes('nano-banana')) return 'gemini';
    if (lower.includes('anthropic')) return 'anthropic';
    if (lower.includes('deepseek')) return 'deepseek';
    if (lower.includes('xai') || lower.includes('x-ai')) return 'xai';
    const dashIndex = lower.indexOf('-');
    return dashIndex > 0 ? lower.slice(0, dashIndex) : lower;
}

function stableValue(value: any): any {
    if (Array.isArray(value)) {
        return value.map((entry) => stableValue(entry));
    }
    if (value && typeof value === 'object') {
        const sorted: Record<string, any> = {};
        for (const key of Object.keys(value).sort()) {
            if (FINGERPRINT_OMIT_KEYS.has(key)) continue;
            sorted[key] = stableValue(value[key]);
        }
        return sorted;
    }
    return value;
}

function canonicalizeProviderUniqueErrorEntry(entry: Partial<ProviderUniqueErrorLogEntry>): ProviderUniqueErrorLogEntry | null {
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const operation = typeof entry.operation === 'string' ? entry.operation.trim() : '';
    const errorMessage = typeof entry.errorMessage === 'string' ? entry.errorMessage : '';
    if (!provider || !operation || !errorMessage) return null;

    const normalizedEntry: Omit<ProviderUniqueErrorLogEntry, 'timestamp' | 'fingerprint'> = {
        provider,
        operation,
        ...(typeof entry.modelId === 'string' && entry.modelId ? { modelId: entry.modelId } : {}),
        ...(typeof entry.endpoint === 'string' && entry.endpoint ? { endpoint: entry.endpoint } : {}),
        ...(typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs)
            ? { latencyMs: Math.max(0, Math.round(entry.latencyMs)) }
            : {}),
        errorMessage,
        ...(entry.errorDetails && typeof entry.errorDetails === 'object' ? { errorDetails: entry.errorDetails } : {}),
    };

    return {
        timestamp: typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : new Date().toISOString(),
        fingerprint: buildProviderUniqueErrorFingerprint(normalizedEntry),
        ...normalizedEntry,
    };
}

function loadExistingProviderUniqueErrorFingerprints(): void {
    if (!fs.existsSync(providerUniqueErrorLogFilePath)) return;
    try {
        const raw = fs.readFileSync(providerUniqueErrorLogFilePath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const compactedLines: string[] = [];
        const seenFingerprints = new Set<string>();
        let changed = false;

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line) as Partial<ProviderUniqueErrorLogEntry>;
                const canonical = canonicalizeProviderUniqueErrorEntry(parsed);
                if (!canonical) {
                    compactedLines.push(line);
                    continue;
                }
                if (seenFingerprints.has(canonical.fingerprint)) {
                    changed = true;
                    continue;
                }
                seenFingerprints.add(canonical.fingerprint);
                providerUniqueErrorFingerprints.add(canonical.fingerprint);
                const serialized = JSON.stringify(canonical);
                if (serialized !== line) {
                    changed = true;
                }
                compactedLines.push(serialized);
            } catch {
                compactedLines.push(line);
            }
        }

        if (changed) {
            const nextContents = compactedLines.length > 0 ? `${compactedLines.join('\n')}\n` : '';
            fs.writeFileSync(providerUniqueErrorLogFilePath, nextContents, 'utf8');
            logger.debug(`[ErrorLogger] Compacted duplicate provider unique errors in ${providerUniqueErrorLogFilePath}`);
        }
    } catch (err: any) {
        logger.error(`[ErrorLogger] Failed to preload provider unique error fingerprints from ${providerUniqueErrorLogFilePath}. Error: ${err.message}`, err);
    }
}

function buildProviderErrorDetails(error: any, extra?: Record<string, any>): Record<string, any> {
    const details: Record<string, any> = { ...(extra || {}) };

    if (error?.name) details.name = error.name;
    if (error?.message) details.message = error.message;
    if (error?.code !== undefined) details.code = error.code;
    if (error?.status !== undefined) details.status = error.status;
    if (error?.statusCode !== undefined) details.statusCode = error.statusCode;
    if (error?.stack) details.stack = error.stack;

    if (error?.response) {
        if (error.response.status !== undefined) details.responseStatus = error.response.status;
        if (error.response.statusText !== undefined) details.responseStatusText = error.response.statusText;
        if (error.response.data !== undefined) details.responseData = error.response.data;
        if (error.response.headers !== undefined) details.responseHeaders = error.response.headers;
    }

    if (error?.config) {
        details.requestConfig = {
            method: error.config.method,
            baseURL: error.config.baseURL,
            url: error.config.url,
            timeout: error.config.timeout,
        };
    }

    if (typeof error?.toJSON === 'function') {
        try {
            details.errorJson = error.toJSON();
        } catch {
            // Ignore provider-specific toJSON failures.
        }
    }

    return sanitizeDetails(details);
}

function classifyFingerprintErrorText(text: string): string {
    const lower = normalizeFingerprintString(text).toLowerCase();
    if (!lower) return '';

    const quotaMetricMatch = lower.match(/quota exceeded for metric:?\s*([^,]+)/i) || lower.match(/quota exceeded for metric:\s*([^,]+)/i);
    if (quotaMetricMatch?.[1]) {
        return `quota:${quotaMetricMatch[1].trim()}`;
    }
    if (lower.includes('you exceeded your current quota') || lower.includes('resource has been exhausted') || lower.includes('insufficient_quota')) {
        return 'quota:exceeded';
    }
    if (lower.includes('no eligible image models found')) {
        return 'imagen:no_eligible_models';
    }
    if (lower.includes('invalid response structure received from gemini api')) {
        return 'gemini:invalid_response_structure';
    }
    if (
        lower.includes('unable to access non-serverless model')
        || lower.includes('dedicated endpoint for the model')
        || lower.includes('model_not_available')
    ) {
        return 'model:not_available_non_serverless';
    }
    if (lower.includes('no endpoints found that support tool use')) {
        return 'tool_use:no_supported_endpoints';
    }
    if (lower.includes('no endpoints found matching your data policy')) {
        return 'data_policy:no_supported_endpoints';
    }
    if (
        lower.includes('tool choice must be auto')
        || lower.includes('tool_choice must be auto')
    ) {
        return 'tool_choice:must_be_auto';
    }
    if (
        lower.includes('specifying functions for tool_choice is not yet supported')
        || lower.includes('tool_choice parameter does not support being set')
        || lower.includes('does not support tool_choice')
        || lower.includes('specifying functions for tool choice is not yet supported')
    ) {
        return 'tool_choice:function_not_supported';
    }
    if (lower.includes('temporarily rate-limited upstream')) {
        return 'rate_limit:upstream_temporary';
    }
    if (lower.includes('you are not allowed to sample from this model')) {
        return 'model:no_access_sample';
    }
    if (lower.includes('user not found')) {
        return 'auth:user_not_found';
    }
    if (lower.includes('requires that either input content or output modality contain audio')) {
        return 'audio:modality_required';
    }
    if (lower.includes('provider returned error')) {
        return 'provider:error';
    }

    return lower;
}

function buildFingerprintErrorSummary(details: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!details || typeof details !== 'object') return undefined;

    const responseError = details.responseData?.error;
    const metadata = responseError?.metadata && typeof responseError.metadata === 'object'
        ? responseError.metadata
        : undefined;

    const summary: Record<string, any> = {
        name: details.name,
        code: details.code,
        status: details.status,
        statusCode: details.statusCode,
        responseStatus: details.responseStatus,
        responseStatusText: details.responseStatusText,
        messageKind: typeof details.message === 'string' ? classifyFingerprintErrorText(details.message) : undefined,
    };

    if (responseError && typeof responseError === 'object') {
        summary.responseError = {
            kind: typeof responseError.message === 'string' ? classifyFingerprintErrorText(responseError.message) : undefined,
            code: responseError.code,
            type: responseError.type,
            status: responseError.status,
        };
    }

    if (metadata) {
        summary.responseErrorMetadata = {
            provider: metadata.provider,
            provider_name: metadata.provider_name,
            provider_id: metadata.provider_id,
            is_byok: metadata.is_byok,
            rawKind: typeof metadata.raw === 'string' ? classifyFingerprintErrorText(metadata.raw) : undefined,
        };
    }

    return normalizeFingerprintValue(summary) as Record<string, any>;
}

function buildProviderUniqueErrorFingerprint(entry: Omit<ProviderUniqueErrorLogEntry, 'timestamp' | 'fingerprint'>): string {
    const fingerprintPayload = stableValue({
        provider: normalizeProviderFingerprintKey(entry.provider),
        operation: entry.operation,
        errorMessage: normalizeFingerprintString(entry.errorMessage),
        errorSummary: buildFingerprintErrorSummary(entry.errorDetails),
    });
    return crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex');
}

async function reserveProviderUniqueFingerprint(fingerprint: string): Promise<boolean> {
    if (providerUniqueErrorFingerprints.has(fingerprint)) {
        return false;
    }

    if (redis && redis.status === 'ready') {
        try {
            const added = await redis.sadd(providerUniqueRedisKey, fingerprint);
            if (Number(added) !== 1) {
                providerUniqueErrorFingerprints.add(fingerprint);
                return false;
            }
        } catch (err: any) {
            logger.warn(`[ErrorLogger] Redis provider unique fingerprint reservation failed for ${fingerprint}: ${err.message}`);
        }
    }

    providerUniqueErrorFingerprints.add(fingerprint);
    return true;
}

function rewriteErrorStackMessage(stack: string | undefined, message: string): string | undefined {
    if (!stack) return undefined;
    const lines = String(stack).split('\n');
    if (lines.length === 0) return `Error: ${message}`;
    if (lines[0].trim().startsWith('at ')) {
        return [`Error: ${message}`, ...lines].join('\n');
    }
    lines[0] = `Error: ${message}`;
    return lines.join('\n');
}

function isProviderAttemptAggregateError(message: string): boolean {
    return (
        message.startsWith('Failed to process request:') ||
        message.startsWith('Failed to process streaming request:')
    );
}

function sanitizeProviderErrorSummary(message: string): string {
    const normalized = String(message || '')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalized.length <= 160) return normalized;
    return `${normalized.slice(0, 157)}...`;
}

function getLastAttemptedProviderId(error: any, details?: Record<string, any>): string | undefined {
    const direct = details?.lastProviderId ?? error?.lastProviderId;
    if (typeof direct === 'string' && direct.trim().length > 0) {
        return direct.trim();
    }

    const attemptedProviders = details?.attemptedProviders ?? error?.attemptedProviders;
    if (!Array.isArray(attemptedProviders) || attemptedProviders.length === 0) {
        return undefined;
    }

    const last = attemptedProviders[attemptedProviders.length - 1];
    return typeof last === 'string' && last.trim().length > 0 ? last.trim() : undefined;
}

function summarizeLastProviderErrorForLogging(error: any, details?: Record<string, any>): string | undefined {
    const raw = details?.lastProviderError ?? error?.lastProviderError;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return undefined;
    }

    const normalized = raw.trim();
    const classified = classifyFingerprintErrorText(normalized);
    if (classified && classified !== normalized.toLowerCase()) {
        return classified;
    }

    return sanitizeProviderErrorSummary(normalized);
}

function isLikelyUserSideRequestFailure(error: any, details?: Record<string, any>): boolean {
    const messages = [
        details?.lastProviderError,
        error?.lastProviderError,
        error?.message,
        error,
    ]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .map((value) => String(value).toLowerCase());

    return messages.some((message) => {
        if (!message) return false;
        if (isModelAccessError(message) || isInsufficientCreditsError(message)) return true;
        return (
            message.startsWith('invalid request') ||
            message.startsWith('failed to parse') ||
            message.includes('bad request') ||
            message.includes('invalid json') ||
            message.includes('invalid argument') ||
            message.includes('invalid request body') ||
            message.includes('could not extract valid user parts') ||
            message.includes('input token count exceeds') ||
            message.includes('maximum number of tokens allowed') ||
            message.includes('image input too large') ||
            message.includes('image exceeds') ||
            message.includes('fetching image from url') ||
            message.includes('cannot fetch content from the provided url') ||
            message.includes('image_url') ||
            message.includes('not available for gemini free-tier keys') ||
            (message.includes('free_tier') && message.includes('limit: 0'))
        );
    });
}

function summarizeAggregateProviderFailure(error: any, details?: Record<string, any>): string {
    const message = String(error?.message || error || '');
    const isStreaming = message.startsWith('Failed to process streaming request:');
    const prefix = isStreaming ? 'Failed to process streaming request' : 'Failed to process request';
    const modelId = details?.modelId ?? error?.modelId;
    const attemptedProviders = details?.attemptedProviders ?? error?.attemptedProviders;
    const candidateProviders = Number(details?.candidateProviders ?? error?.candidateProviders);
    const allSkippedByRateLimit = details?.allSkippedByRateLimit ?? error?.allSkippedByRateLimit;
    const modelSuffix = modelId ? ` for model ${modelId}` : '';
    const lastProviderId = getLastAttemptedProviderId(error, details);
    const lastProviderErrorSummary =
        (typeof details?.lastProviderErrorSummary === 'string' && details.lastProviderErrorSummary.length > 0)
            ? details.lastProviderErrorSummary
            : summarizeLastProviderErrorForLogging(error, details);

    if (Array.isArray(attemptedProviders) && attemptedProviders.length > 0) {
        const providerSuffix = lastProviderId ? ` Last provider: ${lastProviderId}.` : '';
        const causeSuffix = lastProviderErrorSummary ? ` Cause: ${lastProviderErrorSummary}.` : '';
        return `${prefix} after ${attemptedProviders.length} provider attempt(s)${modelSuffix}.${providerSuffix}${causeSuffix}`;
    }

    if (allSkippedByRateLimit === true && Number.isFinite(candidateProviders) && candidateProviders > 0) {
        return `${prefix}: all ${candidateProviders} provider(s)${modelSuffix} are temporarily unavailable.`;
    }

    return `${prefix}${modelSuffix}.`;
}

function normalizeErrorPayloadForLogging(error: any, payload: NormalizedErrorPayload): NormalizedErrorPayload {
    if (!isProviderAttemptAggregateError(payload.message)) return payload;

    const hasRepeatedProviderDetail =
        payload.message.includes('Last error:') ||
        (typeof payload.details?.lastProviderError === 'string' && payload.details.lastProviderError.length > 0);

    if (!hasRepeatedProviderDetail) return payload;
    if (isLikelyUserSideRequestFailure(error, payload.details)) return payload;

    const nextDetails = { ...(payload.details || {}) };
    const lastProviderId = getLastAttemptedProviderId(error, nextDetails);
    const lastProviderErrorSummary = summarizeLastProviderErrorForLogging(error, nextDetails);
    delete nextDetails.lastProviderError;
    if (lastProviderId && nextDetails.lastProviderId === undefined) {
        nextDetails.lastProviderId = lastProviderId;
    }
    if (lastProviderErrorSummary) {
        nextDetails.lastProviderErrorSummary = lastProviderErrorSummary;
    }
    if (nextDetails.failureOrigin === undefined) {
        nextDetails.failureOrigin = 'upstream_provider';
    }

    const nextMessage = summarizeAggregateProviderFailure(error, nextDetails);
    return {
        message: nextMessage,
        stack: rewriteErrorStackMessage(payload.stack, nextMessage),
        details: nextDetails,
    };
}

export async function logUniqueProviderError(context: ProviderErrorLogContext): Promise<void> {
    try {
        const provider = String(context.provider || '').trim();
        const operation = String(context.operation || '').trim();
        if (!provider || !operation) return;

        const entryWithoutFingerprint: Omit<ProviderUniqueErrorLogEntry, 'timestamp' | 'fingerprint'> = {
            provider,
            operation,
            ...(context.modelId ? { modelId: context.modelId } : {}),
            ...(context.endpoint ? { endpoint: context.endpoint } : {}),
            ...(typeof context.latencyMs === 'number' && Number.isFinite(context.latencyMs)
                ? { latencyMs: Math.max(0, Math.round(context.latencyMs)) }
                : {}),
            errorMessage: String(context.error?.message || context.error || 'Unknown provider error'),
            errorDetails: buildProviderErrorDetails(context.error, context.extra),
        };

        const fingerprint = buildProviderUniqueErrorFingerprint(entryWithoutFingerprint);
        const shouldLog = await reserveProviderUniqueFingerprint(fingerprint);
        if (!shouldLog) {
            return;
        }
        const entry: ProviderUniqueErrorLogEntry = {
            timestamp: new Date().toISOString(),
            fingerprint,
            ...entryWithoutFingerprint,
        };

        await appendJsonLine(providerUniqueErrorLogFilePath, JSON.stringify(entry));
        logger.debug(`[ErrorLogger] Logged unique provider error fingerprint ${fingerprint} to ${providerUniqueErrorLogFilePath}`);
    } catch (err: any) {
        logger.error(`[ErrorLogger] Failed to write unique provider error log. Error: ${err.message}`, err);
    }
}

// Renamed function to reflect potential Redis logging
export async function logError(error: any, request?: Request): Promise<void> {
    const timestamp = new Date().toISOString();
    logger.debug(`[ErrorLogger] logError called at ${timestamp}`);

    const errorId = request?.requestId;
    const logEntry: ErrorLogEntry = {
        timestamp,
        errorId,
        errorMessage: 'Unknown error',
    };

    if (request) {
        logEntry.requestMethod = request.method || undefined;
        logEntry.requestUrl = request.url || request.path || undefined;
        logEntry.originIp = request.ip || request.headers?.['x-forwarded-for'] || request.headers?.['x-real-ip'] || undefined;
        if (request.apiKey && typeof request.apiKey === 'string') {
            logEntry.apiKey = redactToken(request.apiKey) ?? undefined;
            logEntry.apiKeyHash = hashToken(request.apiKey).slice(0, 12);
        }
    }

    if (error instanceof Error) {
        // Capture all enumerable properties (modelId, attemptedProviders, etc.)
        const details: Record<string, any> = {};
        for (const key in error) {
            if (Object.prototype.hasOwnProperty.call(error, key) && key !== 'message' && key !== 'stack') {
                details[key] = (error as any)[key];
            }
        }
        // Also capture well-known non-enumerable properties
        const meta = error as any;
        if (meta.code !== undefined && !details.code) details.code = meta.code;
        if (meta.statusCode !== undefined && !details.statusCode) details.statusCode = meta.statusCode;
        if (meta.status !== undefined && !details.status) details.status = meta.status;
        if (meta.modelId !== undefined && !details.modelId) details.modelId = meta.modelId;

        const normalized = normalizeErrorPayloadForLogging(error, {
            message: error.message || '(empty error message)',
            stack: error.stack,
            details: Object.keys(details).length > 0 ? details : undefined,
        });

        logEntry.errorMessage = normalized.message;
        if (normalized.stack) {
            logEntry.errorStack = normalized.stack;
        }
        if (normalized.details && Object.keys(normalized.details).length > 0) {
            logEntry.errorDetails = sanitizeDetails(normalized.details);
        }
    } else if (typeof error === 'object' && error !== null) {
        const otherProps = { ...error };
        delete otherProps.message;
        delete otherProps.stack;

        const normalized = normalizeErrorPayloadForLogging(error, {
            message: error.message || error.errorMessage || error.error || '(no message property)',
            stack: error.stack,
            details: Object.keys(otherProps).length > 0 ? otherProps : undefined,
        });

        logEntry.errorMessage = normalized.message;
        if (normalized.stack) {
            logEntry.errorStack = normalized.stack;
        }
        if (normalized.details && Object.keys(normalized.details).length > 0) {
            logEntry.errorDetails = sanitizeDetails(normalized.details);
        }
    } else if (typeof error === 'string') {
        logEntry.errorMessage = error || '(empty string error)';
    } else {
        logEntry.errorMessage = `Unexpected error type: ${typeof error}`;
        try {
            logEntry.errorDetails = error != null
                ? JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)))
                : { rawValue: String(error) };
        } catch (stringifyError) {
            console.error('[ErrorLogger] Failed to serialize error:', stringifyError);
            logEntry.errorDetails = { rawValue: String(error) };
        }
    }

    const logLine = JSON.stringify(logEntry);

    // Always log to console first
    logger.error(`[ErrorLogger] ${logEntry.errorMessage}`);
    if (logEntry.errorStack) {
        logger.error(`[ErrorLogger] Stack: ${logEntry.errorStack}`);
    }

    let loggedToRedis = false;
    // Log to Redis if available and enabled
    if (logToRedis && redis && redis.status === 'ready') {
        try {
            logger.debug(`[ErrorLogger] Attempting to log to Redis key: ${redisLogKey}`);
            await redis.lpush(redisLogKey, logLine);
            await redis.ltrim(redisLogKey, 0, redisMaxLogEntries - 1);
            loggedToRedis = true;
            logger.debug(`[ErrorLogger] Successfully logged to Redis key: ${redisLogKey}`);
        } catch (redisErr: any) {
            logger.error(`[ErrorLogger] Failed to log error to Redis key ${redisLogKey}. Error: ${redisErr.message}`, redisErr);
        }
    }

    // Always log to file as well (not just as fallback)
    logger.debug(`[ErrorLogger] Attempting to append to log file: ${errorLogFilePath}`);
    try {
        await appendJsonLine(errorLogFilePath, logLine);
        logger.debug(`[ErrorLogger] Successfully wrote to JSON error log: ${errorLogFilePath}`);
    } catch (fileErr: any) {
         logger.error(`[ErrorLogger] CRITICAL: Failed to write to JSON error log file: ${errorLogFilePath}. Error: ${fileErr.message}`, fileErr);
    }

    // Summary of logging results
    if (logToRedis && loggedToRedis) {
        logger.debug(`[ErrorLogger] Error logged to both console and Redis`);
    } else if (logToRedis) {
        logger.debug(`[ErrorLogger] Error logged to console and file (Redis failed or not ready)`);
    } else {
        logger.debug(`[ErrorLogger] Error logged to console and file (Redis disabled)`);
    }
} 
