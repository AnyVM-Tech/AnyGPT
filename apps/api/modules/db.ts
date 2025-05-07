import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

let redis: Redis | null = null;
let redisReadyPromise: Promise<void> | null = null;
// Variable to hold any critical connection error to be included in promise rejection
let criticalRedisConnectionError: Error | null = null;

const redisUrlFromEnv = process.env.REDIS_URL;
const redisUser = process.env.REDIS_USERNAME;
const redisPass = process.env.REDIS_PASSWORD;
const redisDb = process.env.REDIS_DB || '0'; // Default to DB 0 if not specified
const useTls = process.env.REDIS_TLS === 'true';

// Check if essential variables for constructing the URL are provided
if (redisUrlFromEnv && redisUser && redisPass) {
    try {
        // Assuming REDIS_URL is in host:port format
        const urlParts = redisUrlFromEnv.split(':');
        if (urlParts.length !== 2 || !urlParts[0] || !urlParts[1] || isNaN(Number(urlParts[1]))) {
            throw new Error(`Invalid REDIS_URL format. Expected host:port, received: '${redisUrlFromEnv}'`);
        }
        const host = urlParts[0];
        const port = urlParts[1];

        const protocol = useTls ? 'rediss' : 'redis';
        const constructedUrl = `${protocol}://${redisUser}:${redisPass}@${host}:${port}/${redisDb}`;

        console.log(`Constructing Redis connection URL from environment variables (Protocol: ${protocol}).`);
        // Log connection target without credentials for security
        console.log(`Connecting to: ${protocol}://<username>:<password>@${host}:${port}/${redisDb}`); 

        redis = new Redis(constructedUrl, {
            // TLS options might be needed depending on server/cert requirements
            tls: useTls ? { rejectUnauthorized: false } : undefined,
            maxRetriesPerRequest: 3, // Example: Reconnect attempts
            showFriendlyErrorStack: true, // Useful for debugging connection errors
            connectTimeout: 10000 // Added connection timeout for the client itself
        });

    } catch (err: any) {
        console.error("Error constructing Redis connection string or initializing client:", err.message);
        criticalRedisConnectionError = err; // Store the error
        redis = null; // Ensure redis is null if construction/init fails
    }

} else {
    // Log which essential variables are missing
    let missingVars = [];
    if (!redisUrlFromEnv) missingVars.push('REDIS_URL (containing host:port)');
    if (!redisUser) missingVars.push('REDIS_USERNAME');
    if (!redisPass) missingVars.push('REDIS_PASSWORD');
    
    if (missingVars.length > 0) {
        console.log(`Essential Redis environment variables missing: ${missingVars.join(', ')}. Redis client not created.`);
        criticalRedisConnectionError = new Error(`Essential Redis environment variables missing: ${missingVars.join(', ')}.`);
    } else {
        // Should not happen if the initial if condition is correct, but for completeness
        console.log('Redis environment variables not configured as expected. Redis client not created.');
        criticalRedisConnectionError = new Error('Redis environment variables not configured as expected.');
    }
}

// Promise for Redis readiness
if (redis) {
    redisReadyPromise = new Promise((resolve, reject) => {
        const onReady = () => {
            console.log('Redis client is ready (from db.ts promise).');
            if (connectionTimeout) clearTimeout(connectionTimeout);
            redis!.removeListener('error', onError); // Clean up error listener for this promise
            resolve();
        };

        const onError = (err: Error) => {
            console.error('Redis connection error (from db.ts promise listener):', err.message);
            // ioredis handles retries internally. We reject on timeout or if it's a startup error.
            // For now, we primarily rely on the timeout to reject.
            // If 'error' event happens after 'ready', this promise would have already resolved.
        };
        
        redis!.once('ready', onReady); // Use once for the promise resolution
        redis!.on('error', onError); // Listen to errors during connection phase

        const connectionTimeout = setTimeout(() => {
            if (redis && redis.status !== 'ready') {
                const errMsg = `Redis connection attempt timed out after 20 seconds. Status: ${redis.status}`;
                console.error(`[db.ts] ${errMsg}`);
                redis!.removeListener('ready', onReady); // Clean up ready listener
                redis!.removeListener('error', onError);
                reject(new Error(errMsg));
            }
        }, 20000); // 20 seconds timeout for promise
    });
} else {
    // If redis client was not created (e.g., missing env vars), create a rejected promise.
    const errorMessage = criticalRedisConnectionError ? criticalRedisConnectionError.message : "Redis client could not be initialized.";
    redisReadyPromise = Promise.reject(new Error(`[db.ts] Cannot connect to Redis: ${errorMessage}`));
}

// Event listeners (remain the same, but are more for ongoing monitoring after initial connection)
if (redis) {
    redis.on('error', (err) => {
        console.error('Redis connection error:', err);
    });
    redis.on('connect', () => {
        console.log('Attempting to connect to Redis...');
    });
    redis.on('ready', () => {
        console.log('Redis client is ready.');
    });
    redis.on('reconnecting', (time: number) => {
        console.log(`Redis reconnecting in ${time}ms...`);
    });
}

export default redis;
export { redisReadyPromise }; // Export the promise