import fs from 'fs';
import path from 'path';
import redis from '../modules/db.js'; // Import redis client
import type { Request } from '../lib/uws-compat.js';
import { logger } from './logger.js';
import { isInsufficientCreditsError, isModelAccessError } from './errorClassification.js';
import { hashToken, redactToken } from './redaction.js';

const logDirectory = path.resolve(process.cwd(), 'logs'); // Logs at the workspace root
const errorLogFilePath = path.join(logDirectory, 'api-error.jsonl'); // Changed to .jsonl

// Configuration from environment variables
const logToRedis = process.env.ERROR_LOG_TO_REDIS === 'true';
const redisLogKey = process.env.REDIS_ERROR_LOG_KEY || 'api:error_logs';
const redisMaxLogEntries = parseInt(process.env.REDIS_ERROR_LOG_MAX_ENTRIES || '1000', 10);

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

    if (Array.isArray(attemptedProviders) && attemptedProviders.length > 0) {
        return `${prefix} after ${attemptedProviders.length} provider attempt(s)${modelSuffix}.`;
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
    delete nextDetails.lastProviderError;
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
        await fs.promises.appendFile(errorLogFilePath, logLine + '\n', 'utf8');
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
