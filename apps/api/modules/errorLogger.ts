import fs from 'fs';
import path from 'path';
import redis from '../modules/db.js'; // Import redis client
import type { Request } from '../lib/uws-compat.js';
import { logger } from './logger.js';
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
    apiKey?: string;
    apiKeyHash?: string;
    originIp?: string;
    requestMethod?: string;
    requestUrl?: string;
    errorMessage: string;
    errorStack?: string;
    errorDetails?: any;
}

function sanitizeDetails(details: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(details)) {
        const lowered = key.toLowerCase();
        if (['apikey', 'api_key', 'authorization', 'x-api-key', 'token', 'secret'].includes(lowered)) {
            sanitized[key] = typeof value === 'string' ? redactToken(value) : '[redacted]';
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// Renamed function to reflect potential Redis logging
export async function logError(error: any, request?: Request): Promise<void> {
    const timestamp = new Date().toISOString();
    logger.debug(`[ErrorLogger] logError called at ${timestamp}`);

    const logEntry: ErrorLogEntry = {
        timestamp,
        errorMessage: 'Unknown error',
    };

    if (request) {
        logEntry.requestMethod = request.method;
        logEntry.requestUrl = request.url;
        logEntry.originIp = request.ip || request.headers?.['x-forwarded-for'] || request.headers?.['x-real-ip'];
        // Assuming apiKey is attached to the request object as defined in your openai.ts middleware
        if (request.apiKey && typeof request.apiKey === 'string') {
            logEntry.apiKey = redactToken(request.apiKey) ?? undefined;
            logEntry.apiKeyHash = hashToken(request.apiKey).slice(0, 12);
        }
    }

    if (error instanceof Error) {
        logEntry.errorMessage = error.message;
        if (error.stack) {
            logEntry.errorStack = error.stack;
        }
        // Capture other enumerable properties from the error object, if any
        const details: Record<string, any> = {};
        for (const key in error) {
            if (Object.prototype.hasOwnProperty.call(error, key) && key !== 'message' && key !== 'stack') {
                details[key] = (error as any)[key];
            }
        }
        if (Object.keys(details).length > 0) {
            logEntry.errorDetails = sanitizeDetails(details);
        }
    } else if (typeof error === 'object' && error !== null && error.message) {
        logEntry.errorMessage = error.message;
        if (error.stack) {
            logEntry.errorStack = error.stack;
        }
        const otherProps = { ...error };
        delete otherProps.message;
        delete otherProps.stack;
        if (Object.keys(otherProps).length > 0) {
            logEntry.errorDetails = sanitizeDetails(otherProps);
        }
    } else {
        logEntry.errorMessage = 'Error object was not an instance of Error and had no message property.';
        try {
            logEntry.errorDetails = JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)));
        } catch (stringifyError) {
            console.error('[ErrorLogger] Failed to serialize non-Error object:', stringifyError);
            logEntry.errorDetails = 'Could not serialize error object';
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
