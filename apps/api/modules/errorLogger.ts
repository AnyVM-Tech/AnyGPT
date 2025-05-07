import fs from 'fs';
import path from 'path';
import HyperExpress from 'hyper-express'; // For Request type, if used
import redis from '../modules/db'; // Import redis client

const logDirectory = path.resolve(process.cwd(), 'logs'); // Logs at the workspace root
const errorLogFilePath = path.join(logDirectory, 'api-error.jsonl'); // Changed to .jsonl

// Configuration from environment variables
const logToRedis = process.env.ERROR_LOG_TO_REDIS === 'true';
const redisLogKey = process.env.REDIS_ERROR_LOG_KEY || 'api:error_logs';
const redisMaxLogEntries = parseInt(process.env.REDIS_ERROR_LOG_MAX_ENTRIES || '1000', 10);

console.log(`[ErrorLogger] Current working directory: ${process.cwd()}`);
console.log(`[ErrorLogger] Log directory target: ${logDirectory}`);
console.log(`[ErrorLogger] Error log file path: ${errorLogFilePath}`);
console.log(`[ErrorLogger] Log to Redis enabled: ${logToRedis}`);
if (logToRedis) {
    console.log(`[ErrorLogger] Redis log key: ${redisLogKey}`);
    console.log(`[ErrorLogger] Redis max log entries: ${redisMaxLogEntries}`);
}

// Ensure log directory exists
if (!fs.existsSync(logDirectory)) {
    console.log(`[ErrorLogger] Log directory does not exist. Attempting to create: ${logDirectory}`);
    try {
        fs.mkdirSync(logDirectory, { recursive: true });
        console.log(`[ErrorLogger] Successfully created log directory: ${logDirectory}`);
    } catch (e: any) {
        console.error(`[ErrorLogger] CRITICAL: Failed to create log directory: ${logDirectory}. Error: ${e.message}`, e);
    }
} else {
    console.log(`[ErrorLogger] Log directory already exists: ${logDirectory}`);
}

interface ErrorLogEntry {
    timestamp: string;
    apiKey?: string;
    requestMethod?: string;
    requestUrl?: string;
    errorMessage: string;
    errorStack?: string;
    errorDetails?: any;
}

// Renamed function to reflect potential Redis logging
export async function logError(error: any, request?: HyperExpress.Request): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[ErrorLogger] logError called at ${timestamp}`);

    const logEntry: ErrorLogEntry = {
        timestamp,
        errorMessage: 'Unknown error',
    };

    if (request) {
        logEntry.requestMethod = request.method;
        logEntry.requestUrl = request.url;
        // Assuming apiKey is attached to the request object as defined in your openai.ts middleware
        if (request.apiKey && typeof request.apiKey === 'string') {
            logEntry.apiKey = request.apiKey; // Capture API key
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
            logEntry.errorDetails = details;
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
            logEntry.errorDetails = otherProps;
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

    let loggedToRedis = false;
    if (logToRedis && redis && redis.status === 'ready') {
        try {
            console.log(`[ErrorLogger] Attempting to log to Redis key: ${redisLogKey}`);
            await redis.lpush(redisLogKey, logLine);
            await redis.ltrim(redisLogKey, 0, redisMaxLogEntries - 1);
            loggedToRedis = true;
            console.log(`[ErrorLogger] Successfully logged to Redis key: ${redisLogKey}`);
        } catch (redisErr: any) {
            console.error(`[ErrorLogger] Failed to log error to Redis key ${redisLogKey}. Error: ${redisErr.message}. Falling back to file.`, redisErr);
        }
    }

    // Fallback to file if Redis logging is disabled, not ready, or failed
    if (!loggedToRedis) {
        console.log(`[ErrorLogger] Attempting to append to log file: ${errorLogFilePath}`);
        console.log(`[ErrorLogger] Log line content: ${logLine.trim()}`);
        try {
            await fs.promises.appendFile(errorLogFilePath, logLine + '\n', 'utf8');
            console.log(`[ErrorLogger] Successfully wrote to JSON error log: ${errorLogFilePath}`);
        } catch (fileErr: any) {
             console.error(`[ErrorLogger] CRITICAL: Failed to write to JSON error log file: ${errorLogFilePath}. Error: ${fileErr.message}`, fileErr);
             // If both Redis and file logging fail, we might have lost the log
             if (logToRedis) {
                 console.error('[ErrorLogger] Logging failed for both Redis and Filesystem.');
             }
        }
    }
} 