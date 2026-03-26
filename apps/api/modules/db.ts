declare const Bun: any;

import dotenv from 'dotenv';

dotenv.config();

type RedisStatus = 'wait' | 'connecting' | 'reconnecting' | 'ready' | 'end';
type RedisEvent = 'connect' | 'ready' | 'error' | 'reconnecting' | 'close' | 'message';
type RedisListener = (...args: any[]) => void;
type RedisCommandArg = string | number;

type RawBunRedisClient = {
    connect: () => Promise<void>;
    close: () => void | Promise<void>;
    duplicate: () => any;
    send: (command: string, args?: string[]) => Promise<any>;
    subscribe: (channel: string, callback?: (...args: any[]) => void) => Promise<any>;
    connected?: boolean;
    onconnect?: (() => void) | undefined;
    onclose?: ((error?: unknown) => void) | undefined;
};

function createListenerStore(): Record<RedisEvent, Set<RedisListener>> {
    return {
        connect: new Set(),
        ready: new Set(),
        error: new Set(),
        reconnecting: new Set(),
        close: new Set(),
        message: new Set(),
    };
}

function normalizeRedisError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(typeof error === 'string' ? error : String(error ?? 'Unknown Redis error'));
}

function toRedisArgs(args: RedisCommandArg[]): string[] {
    return args.map((arg) => String(arg));
}

function normalizePubSubMessage(expectedChannel: string, args: any[]): { channel: string; message: string } {
    const stringArgs = args.filter((arg) => typeof arg === 'string') as string[];

    if (stringArgs.length === 1) {
        return { channel: expectedChannel, message: stringArgs[0] };
    }

    if (stringArgs.length >= 2) {
        if (stringArgs[0] === expectedChannel) {
            return { channel: stringArgs[0], message: stringArgs[1] };
        }
        if (stringArgs[1] === expectedChannel) {
            return { channel: stringArgs[1], message: stringArgs[0] };
        }
        return { channel: stringArgs[0], message: stringArgs[1] };
    }

    return { channel: expectedChannel, message: String(args.at(-1) ?? '') };
}

class RedisMulti {
    private commands: Array<{ command: string; args: RedisCommandArg[] }> = [];

    constructor(private readonly client: Redis) {}

    hset(key: string, field: string, value: string): this {
        this.commands.push({ command: 'HSET', args: [key, field, value] });
        return this;
    }

    del(...keys: string[]): this {
        this.commands.push({ command: 'DEL', args: keys });
        return this;
    }

    async exec(): Promise<any> {
        await this.client.sendCommand('MULTI');
        try {
            for (const { command, args } of this.commands) {
                await this.client.sendCommand(command, ...args);
            }
            return await this.client.sendCommand('EXEC');
        } catch (error) {
            try {
                await this.client.sendCommand('DISCARD');
            } catch {
                // ignore discard failure after a failed transaction
            }
            throw error;
        } finally {
            this.commands = [];
        }
    }
}

export class Redis {
    public status: RedisStatus = 'wait';

    private rawClient: RawBunRedisClient;
    private readonly listeners = createListenerStore();
    private readonly subscriptions = new Map<string, (...args: any[]) => void>();
    private connectPromise: Promise<void> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private manuallyClosed = false;
    private hasConnectedOnce = false;

    constructor(private readonly connectionString: string, autoConnect: boolean = true) {
        this.rawClient = this.createRawClient();
        if (autoConnect) {
            void this.connect().catch(() => {
                // Initial readiness is surfaced via redisReadyPromise and ongoing event logs.
            });
        }
    }

    private createRawClient(): RawBunRedisClient {
        const client = new Bun.RedisClient(this.connectionString) as RawBunRedisClient;

        client.onconnect = () => {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            const needsResubscribe = this.hasConnectedOnce && this.subscriptions.size > 0;
            this.hasConnectedOnce = true;
            this.reconnectAttempts = 0;
            this.status = 'ready';

            if (needsResubscribe) {
                for (const [channel, handler] of this.subscriptions) {
                    void client.subscribe(channel, handler).catch((error: unknown) => {
                        this.emit('error', normalizeRedisError(error));
                    });
                }
            }

            this.emit('connect');
            this.emit('ready');
        };

        client.onclose = (error?: unknown) => {
            const normalized = error ? normalizeRedisError(error) : null;
            const shouldReconnect = !this.manuallyClosed;
            this.status = 'end';

            if (normalized && !this.manuallyClosed) {
                this.emit('error', normalized);
            }
            this.emit('close');

            if (shouldReconnect) {
                this.scheduleReconnect();
            }
        };

        return client;
    }

    private emit(event: RedisEvent, ...args: any[]): void {
        for (const listener of Array.from(this.listeners[event])) {
            try {
                listener(...args);
            } catch (error) {
                console.error(`[db.ts] Redis listener error for event ${event}:`, error);
            }
        }
    }

    on(event: RedisEvent, listener: RedisListener): this {
        this.listeners[event].add(listener);
        return this;
    }

    once(event: RedisEvent, listener: RedisListener): this {
        const wrapped: RedisListener = (...args: any[]) => {
            this.removeListener(event, wrapped);
            listener(...args);
        };
        return this.on(event, wrapped);
    }

    removeListener(event: RedisEvent, listener: RedisListener): this {
        this.listeners[event].delete(listener);
        return this;
    }

    private scheduleReconnect(): void {
        if (this.manuallyClosed || this.reconnectTimer) return;

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
        this.reconnectAttempts += 1;
        this.status = 'reconnecting';
        this.emit('reconnecting', delay);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.rawClient = this.createRawClient();
            void this.connect().catch(() => {
                // Reconnect failures continue to surface through error events and retry scheduling.
            });
        }, delay);
    }

    async connect(): Promise<void> {
        if (this.manuallyClosed) return;
        if (this.status === 'ready' && this.rawClient.connected) return;
        if (this.connectPromise) return this.connectPromise;

        if (this.status !== 'reconnecting') {
            this.status = 'connecting';
        }

        const currentClient = this.rawClient;
        this.connectPromise = currentClient.connect()
            .then(() => {
                if (this.rawClient === currentClient && currentClient.connected) {
                    this.status = 'ready';
                }
            })
            .catch((error: unknown) => {
                const normalized = normalizeRedisError(error);
                this.emit('error', normalized);
                this.scheduleReconnect();
                throw normalized;
            })
            .finally(() => {
                this.connectPromise = null;
            });

        return this.connectPromise;
    }

    private async ensureConnected(): Promise<void> {
        if (this.manuallyClosed) {
            throw new Error('Redis client is closed.');
        }
        if (this.status === 'ready' && this.rawClient.connected) return;
        await this.connect();
    }

    async sendCommand(command: string, ...args: RedisCommandArg[]): Promise<any> {
        await this.ensureConnected();
        try {
            return await this.rawClient.send(command, toRedisArgs(args));
        } catch (error: unknown) {
            const normalized = normalizeRedisError(error);
            this.emit('error', normalized);
            this.scheduleReconnect();
            throw normalized;
        }
    }

    async get(key: string): Promise<string | null> {
        return await this.sendCommand('GET', key);
    }

    async set(key: string, value: string, ...args: RedisCommandArg[]): Promise<string | null> {
        return await this.sendCommand('SET', key, value, ...args);
    }

    async del(...keys: string[]): Promise<number> {
        const result = await this.sendCommand('DEL', ...keys);
        return Number(result ?? 0);
    }

    async hget(key: string, field: string): Promise<string | null> {
        return await this.sendCommand('HGET', key, field);
    }

    async hset(key: string, field: string, value: string): Promise<number> {
        const result = await this.sendCommand('HSET', key, field, value);
        return Number(result ?? 0);
    }

    async hdel(key: string, ...fields: string[]): Promise<number> {
        const result = await this.sendCommand('HDEL', key, ...fields);
        return Number(result ?? 0);
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        const result = await this.sendCommand('HGETALL', key);
        if (Array.isArray(result)) {
            const record: Record<string, string> = {};
            for (let index = 0; index < result.length; index += 2) {
                const field = result[index];
                const value = result[index + 1];
                if (typeof field === 'string' && typeof value === 'string') {
                    record[field] = value;
                }
            }
            return record;
        }
        if (result && typeof result === 'object') {
            const record: Record<string, string> = {};
            for (const [field, value] of Object.entries(result as Record<string, unknown>)) {
                if (typeof value === 'string') {
                    record[field] = value;
                }
            }
            return record;
        }
        return {};
    }

    async lpush(key: string, value: string): Promise<number> {
        const result = await this.sendCommand('LPUSH', key, value);
        return Number(result ?? 0);
    }

    async ltrim(key: string, start: number, stop: number): Promise<string | null> {
        return await this.sendCommand('LTRIM', key, start, stop);
    }

    async sadd(key: string, ...members: RedisCommandArg[]): Promise<number> {
        const result = await this.sendCommand('SADD', key, ...members);
        return Number(result ?? 0);
    }

    async pttl(key: string): Promise<number> {
        const result = await this.sendCommand('PTTL', key);
        return Number(result ?? -1);
    }

    async publish(channel: string, message: string): Promise<number> {
        const result = await this.sendCommand('PUBLISH', channel, message);
        return Number(result ?? 0);
    }

    async subscribe(channel: string): Promise<any> {
        const handler = this.subscriptions.get(channel) ?? ((...args: any[]) => {
            const { channel: eventChannel, message } = normalizePubSubMessage(channel, args);
            this.emit('message', eventChannel, message);
        });

        this.subscriptions.set(channel, handler);
        await this.ensureConnected();

        try {
            return await this.rawClient.subscribe(channel, handler);
        } catch (error: unknown) {
            const normalized = normalizeRedisError(error);
            this.emit('error', normalized);
            this.scheduleReconnect();
            throw normalized;
        }
    }

    async watch(...keys: string[]): Promise<any> {
        return await this.sendCommand('WATCH', ...keys);
    }

    async unwatch(): Promise<any> {
        return await this.sendCommand('UNWATCH');
    }

    multi(): RedisMulti {
        return new RedisMulti(this);
    }

    async eval(script: string, numKeys: number, ...args: RedisCommandArg[]): Promise<any> {
        return await this.sendCommand('EVAL', script, numKeys, ...args);
    }

    duplicate(): Redis {
        return new Redis(this.connectionString, true);
    }

    async quit(): Promise<void> {
        this.manuallyClosed = true;
        this.status = 'end';

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        try {
            await Promise.resolve(this.rawClient.close());
        } catch {
            // ignore close errors during shutdown
        }
    }
}

let redis: Redis | null = null;
let redisReadyPromise: Promise<void> | null = null;
let criticalRedisConnectionError: Error | null = null;

const redisUrlFromEnv = process.env.REDIS_URL;
const redisUser = process.env.REDIS_USERNAME;
const redisPass = process.env.REDIS_PASSWORD;
const redisDb = process.env.REDIS_DB || '0';
const useTls = process.env.REDIS_TLS === 'true';

function buildRedisConnectionString(): string {
    if (typeof Bun?.RedisClient !== 'function') {
        throw new Error('Bun.RedisClient is not available in the current runtime.');
    }

    if (!redisUrlFromEnv) {
        throw new Error('Essential Redis environment variables missing: REDIS_URL (containing host:port).');
    }

    const protocol = useTls ? 'rediss' : 'redis';

    if (redisUrlFromEnv.includes('://')) {
        const url = new URL(redisUrlFromEnv);
        if (redisUser) url.username = redisUser;
        if (redisPass) url.password = redisPass;
        if (!url.pathname || url.pathname === '/') url.pathname = `/${redisDb}`;
        url.protocol = `${protocol}:`;
        console.log(`Constructing Redis connection URL from environment variables (Protocol: ${protocol}).`);
        console.log(`Connecting to: ${protocol}://<username>:<password>@${url.host}${url.pathname}`);
        return url.toString();
    }

    if (!redisUser || !redisPass) {
        const missingVars = [
            !redisUser ? 'REDIS_USERNAME' : null,
            !redisPass ? 'REDIS_PASSWORD' : null,
        ].filter(Boolean);
        throw new Error(`Essential Redis environment variables missing: ${missingVars.join(', ')}.`);
    }

    const urlParts = redisUrlFromEnv.split(':');
    if (urlParts.length !== 2 || !urlParts[0] || !urlParts[1] || Number.isNaN(Number(urlParts[1]))) {
        throw new Error(`Invalid REDIS_URL format. Expected host:port, received: '${redisUrlFromEnv}'`);
    }

    const [host, port] = urlParts;
    const constructedUrl = `${protocol}://${encodeURIComponent(redisUser)}:${encodeURIComponent(redisPass)}@${host}:${port}/${redisDb}`;

    console.log(`Constructing Redis connection URL from environment variables (Protocol: ${protocol}).`);
    console.log(`Connecting to: ${protocol}://<username>:<password>@${host}:${port}/${redisDb}`);
    return constructedUrl;
}

try {
    const connectionString = buildRedisConnectionString();
    redis = new Redis(connectionString, true);
} catch (err: any) {
    console.error('Error constructing Redis connection string or initializing client:', err.message);
    criticalRedisConnectionError = err;
    redis = null;
}

if (redis) {
    redisReadyPromise = new Promise((resolve, reject) => {
        let settled = false;

        const finalize = (callback: () => void) => {
            if (settled) return;
            settled = true;
            if (connectionTimeout) clearTimeout(connectionTimeout);
            redis!.removeListener('error', onError);
            callback();
        };

        const onReady = () => {
            console.log('Redis client is ready (from db.ts promise).');
            finalize(resolve);
        };

        const onError = (err: Error) => {
            console.error('Redis connection error (from db.ts promise listener):', err.message);
        };

        redis!.once('ready', onReady);
        redis!.on('error', onError);

        const connectionTimeout = setTimeout(() => {
            if (redis && redis.status !== 'ready') {
                const errMsg = `Redis connection attempt timed out after 20 seconds. Status: ${redis.status}`;
                console.error(`[db.ts] ${errMsg}`);
                finalize(() => reject(new Error(errMsg)));
            }
        }, 20_000);

        if (redis!.status === 'ready') {
            onReady();
        }
    });
} else {
    const errorMessage = criticalRedisConnectionError ? criticalRedisConnectionError.message : 'Redis client could not be initialized.';
    console.warn(`[db.ts] Redis disabled: ${errorMessage}`);
    redisReadyPromise = null;
}

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
export { redisReadyPromise };
