import fs from 'fs';
import path from 'path';
import redis from './db.js'; 
import { Redis } from 'ioredis'; 

// --- Define or Import Data Structure Interfaces ---

// Represents the runtime data held for a specific model WITHIN a provider entry
interface ProviderModelData { 
    id: string;
    token_generation_speed: number;
    response_times: any[]; // Array of ResponseEntry objects
    errors: number;
    consecutive_errors: number;
    avg_response_time: number | null;
    avg_provider_latency: number | null;
    avg_token_speed: number | null;
}

// FIX: Add export
export interface LoadedProviderData { 
    id: string; 
    apiKey: string | null; // Make consistent with Provider interface
    provider_url: string; // Make required, consistent with Provider interface
    streamingCompatible?: boolean;
    models: { [key: string]: ProviderModelData };
    disabled: boolean; // Make required with default false
    avg_response_time: number | null;
    avg_provider_latency: number | null;
    errors: number;
    provider_score: number | null;
}
// FIX: Add export
export type LoadedProviders = LoadedProviderData[];

// FIX: Add export (if UserData/KeysFile are defined here and needed elsewhere)
// Or ensure they are exported from userData.ts if defined there
export interface UserData { 
    userId: string; 
    tokenUsage: number;
    requestCount: number;
    role: 'admin' | 'user';
    tier: string;
}
export interface KeysFile { 
    [apiKey: string]: UserData; 
}

// FIX: Add export
export interface ModelDefinition {
    id: string;
    object: "model"; // Add object field with literal type
    created: number;  // Add created field
    owned_by: string; // Add owned_by field
    providers: number; // Add providers field
    throughput?: number | null;
    capabilities?: string[];
}
// FIX: Add export
export interface ModelsFileStructure { object: string; data: ModelDefinition[]; }

// --- Type Definitions for DataManager ---
type DataType = 'providers' | 'keys' | 'models';
type ManagedDataStructure = LoadedProviders | KeysFile | ModelsFileStructure;

// --- Configuration ---
const filePaths: Record<DataType, string> = {
    providers: path.resolve('providers.json'),
    keys: path.resolve('keys.json'),
    models: path.resolve('models.json'),
};
const legacyRedisKeys: Record<DataType, string> = {
    providers: 'api:providers_data',
    keys: 'api:keys_data',
    models: 'api:models_data', 
};
const redisHashKey = 'api:data';
const redisHashFields: Record<DataType, string> = {
    providers: 'p',
    keys: 'k',
    models: 'm',
};
const redisMigrationMarkerField = '__legacy_migrated_v1';

// In-memory cache to avoid re-hitting Redis/filesystem on every request, and to provide a
// fast fallback when Redis is slow or temporarily unavailable.
const inMemoryCache: Partial<Record<DataType, { value: ManagedDataStructure; ts: number }>> = {};
const CACHE_TTL_MS = 5_000; // keep data warm for a few seconds between requests

// Utility: wrap an async call with a timeout to avoid hanging on slow Redis responses.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
        promise
            .then((val) => { clearTimeout(timer); resolve(val); })
            .catch((err) => { clearTimeout(timer); reject(err); });
    });
}
const defaultEmptyData: Record<DataType, any> = {
    providers: [],
    keys: {},
    models: { object: 'list', data: [] },
};
let lastModelsMirrorSignature: string | null = null;

// Set to track if filesystem fallback has been logged for a dataType
const filesystemFallbackLogged = new Set<DataType>();

// Prefer Redis by default when available; allow forcing filesystem via env.
const dataSourcePreference: 'redis' | 'filesystem' = process.env.DATA_SOURCE_PREFERENCE === 'filesystem' ? 'filesystem' : 'redis';
console.log(`[DataManager] Data source preference set to: ${dataSourcePreference}`);

// --- DataManager Class ---
class DataManager {
    private redisClient: Redis | null;

    constructor(redisInstance: Redis | null) {
        this.redisClient = redisInstance;
        if (this.redisClient) {
             this.redisClient.on('ready', () => console.log("DataManager: Redis client ready."));
             this.redisClient.on('error', (err) => console.error("DataManager: Redis client error:", err));
             console.log(`DataManager initialized with Redis client (${this.redisClient.status}).`);
        } else {
            console.log("DataManager initialized without Redis client (using filesystem only).");
        }
    }

    private isRedisReady(): boolean {
        return !!this.redisClient && this.redisClient.status === 'ready'; 
    }

    private cloneData<T extends ManagedDataStructure>(data: T): T {
        return JSON.parse(JSON.stringify(data));
    }

    private mergeKeyRecords(a?: Partial<UserData>, b?: Partial<UserData>): UserData {
        const roleA = a?.role === 'admin' ? 'admin' : (a?.role === 'user' ? 'user' : undefined);
        const roleB = b?.role === 'admin' ? 'admin' : (b?.role === 'user' ? 'user' : undefined);

        return {
            userId: (typeof b?.userId === 'string' && b.userId) ? b.userId : ((typeof a?.userId === 'string' && a.userId) ? a.userId : 'unknown_user'),
            tokenUsage: Math.max(0, Number.isFinite(Number(a?.tokenUsage)) ? Number(a?.tokenUsage) : 0, Number.isFinite(Number(b?.tokenUsage)) ? Number(b?.tokenUsage) : 0),
            requestCount: Math.max(0, Number.isFinite(Number(a?.requestCount)) ? Number(a?.requestCount) : 0, Number.isFinite(Number(b?.requestCount)) ? Number(b?.requestCount) : 0),
            role: roleA === 'admin' || roleB === 'admin' ? 'admin' : (roleB || roleA || 'user'),
            tier: (typeof b?.tier === 'string' && b.tier) ? b.tier : ((typeof a?.tier === 'string' && a.tier) ? a.tier : 'free'),
        };
    }

    private mergeKeysData(redisKeys: KeysFile, fsKeys: KeysFile): KeysFile {
        const merged: KeysFile = {};
        const allApiKeys = new Set<string>([...Object.keys(redisKeys || {}), ...Object.keys(fsKeys || {})]);

        for (const apiKey of allApiKeys) {
            const redisUser = redisKeys?.[apiKey];
            const fsUser = fsKeys?.[apiKey];
            merged[apiKey] = this.mergeKeyRecords(fsUser, redisUser);
        }

        return this.normalizeKeysSchema(merged).normalized;
    }

    private normalizeProviderModelData(raw: Partial<ProviderModelData> | undefined, modelId: string): ProviderModelData {
        const responseTimes = Array.isArray(raw?.response_times) ? raw!.response_times : [];
        return {
            id: typeof raw?.id === 'string' && raw.id ? raw.id : modelId,
            token_generation_speed: typeof raw?.token_generation_speed === 'number' && !Number.isNaN(raw.token_generation_speed) ? raw.token_generation_speed : 50,
            response_times: responseTimes,
            errors: typeof raw?.errors === 'number' && !Number.isNaN(raw.errors) ? Math.max(0, raw.errors) : 0,
            consecutive_errors: typeof raw?.consecutive_errors === 'number' && !Number.isNaN(raw.consecutive_errors) ? Math.max(0, raw.consecutive_errors) : 0,
            avg_response_time: typeof raw?.avg_response_time === 'number' ? raw.avg_response_time : null,
            avg_provider_latency: typeof raw?.avg_provider_latency === 'number' ? raw.avg_provider_latency : null,
            avg_token_speed: typeof raw?.avg_token_speed === 'number' ? raw.avg_token_speed : null,
        };
    }

    private mergeResponseTimes(a: any[], b: any[]): any[] {
        const combined = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
            .filter((entry) => entry && typeof entry.timestamp === 'number');

        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const entry of combined) {
            const key = [
                entry.timestamp,
                entry.response_time ?? '',
                entry.input_tokens ?? '',
                entry.output_tokens ?? '',
                entry.apiKey ?? '',
            ].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(entry);
        }

        deduped.sort((x, y) => Number(y?.timestamp || 0) - Number(x?.timestamp || 0));
        return deduped.slice(0, 1000);
    }

    private mergeProviderModelData(fsModel: Partial<ProviderModelData> | undefined, redisModel: Partial<ProviderModelData> | undefined, modelId: string): ProviderModelData {
        const normalizedFs = this.normalizeProviderModelData(fsModel, modelId);
        const normalizedRedis = this.normalizeProviderModelData(redisModel, modelId);
        return {
            id: normalizedRedis.id || normalizedFs.id || modelId,
            token_generation_speed: Math.max(1, normalizedRedis.token_generation_speed || normalizedFs.token_generation_speed || 50),
            response_times: this.mergeResponseTimes(normalizedFs.response_times, normalizedRedis.response_times),
            errors: Math.max(normalizedFs.errors, normalizedRedis.errors),
            consecutive_errors: Math.max(normalizedFs.consecutive_errors, normalizedRedis.consecutive_errors),
            avg_response_time: normalizedRedis.avg_response_time ?? normalizedFs.avg_response_time,
            avg_provider_latency: normalizedRedis.avg_provider_latency ?? normalizedFs.avg_provider_latency,
            avg_token_speed: normalizedRedis.avg_token_speed ?? normalizedFs.avg_token_speed,
        };
    }

    private normalizeProviderData(raw: Partial<LoadedProviderData> | undefined, providerId: string): LoadedProviderData {
        const models: { [key: string]: ProviderModelData } = {};
        const rawModels = raw?.models || {};
        for (const [modelId, modelData] of Object.entries(rawModels)) {
            models[modelId] = this.normalizeProviderModelData(modelData as Partial<ProviderModelData>, modelId);
        }

        return {
            id: typeof raw?.id === 'string' && raw.id ? raw.id : providerId,
            apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : null,
            provider_url: typeof raw?.provider_url === 'string' ? raw.provider_url : '',
            streamingCompatible: typeof raw?.streamingCompatible === 'boolean' ? raw.streamingCompatible : undefined,
            models,
            disabled: Boolean(raw?.disabled),
            avg_response_time: typeof raw?.avg_response_time === 'number' ? raw.avg_response_time : null,
            avg_provider_latency: typeof raw?.avg_provider_latency === 'number' ? raw.avg_provider_latency : null,
            errors: typeof raw?.errors === 'number' && !Number.isNaN(raw.errors) ? Math.max(0, raw.errors) : 0,
            provider_score: typeof raw?.provider_score === 'number' ? raw.provider_score : null,
        };
    }

    private mergeProvidersData(redisProviders: LoadedProviders, fsProviders: LoadedProviders): LoadedProviders {
        const fsMap = new Map<string, LoadedProviderData>();
        const redisMap = new Map<string, LoadedProviderData>();

        for (const provider of fsProviders || []) {
            if (!provider?.id) continue;
            fsMap.set(provider.id, this.normalizeProviderData(provider, provider.id));
        }
        for (const provider of redisProviders || []) {
            if (!provider?.id) continue;
            redisMap.set(provider.id, this.normalizeProviderData(provider, provider.id));
        }

        const allProviderIds = new Set<string>([...fsMap.keys(), ...redisMap.keys()]);
        const merged: LoadedProviders = [];

        for (const providerId of allProviderIds) {
            const fsProvider = fsMap.get(providerId);
            const redisProvider = redisMap.get(providerId);
            const hasFilesystemProvider = fsMap.has(providerId);
            const baseFs = this.normalizeProviderData(fsProvider, providerId);
            const baseRedis = this.normalizeProviderData(redisProvider, providerId);

            const modelIds = new Set<string>([
                ...Object.keys(baseFs.models || {}),
                ...Object.keys(baseRedis.models || {}),
            ]);
            const mergedModels: { [key: string]: ProviderModelData } = {};
            for (const modelId of modelIds) {
                mergedModels[modelId] = this.mergeProviderModelData(baseFs.models?.[modelId], baseRedis.models?.[modelId], modelId);
            }

            merged.push({
                id: providerId,
                apiKey: hasFilesystemProvider ? baseFs.apiKey : (baseRedis.apiKey || null),
                provider_url: baseRedis.provider_url || baseFs.provider_url || '',
                streamingCompatible: typeof baseRedis.streamingCompatible === 'boolean' ? baseRedis.streamingCompatible : baseFs.streamingCompatible,
                models: mergedModels,
                disabled: Boolean(baseFs.disabled || baseRedis.disabled),
                avg_response_time: baseRedis.avg_response_time ?? baseFs.avg_response_time,
                avg_provider_latency: baseRedis.avg_provider_latency ?? baseFs.avg_provider_latency,
                errors: Math.max(baseFs.errors || 0, baseRedis.errors || 0),
                provider_score: baseRedis.provider_score ?? baseFs.provider_score,
            });
        }

        merged.sort((a, b) => a.id.localeCompare(b.id));
        return merged;
    }

    public async syncKeysBetweenRedisAndFilesystem(): Promise<void> {
        const filePath = filePaths.keys;

        let fsKeys: KeysFile = {};
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                fsKeys = JSON.parse(raw || '{}') as KeysFile;
            }
        } catch (err) {
            console.error('[DataManager] Failed reading keys from filesystem for sync:', err);
        }

        let redisKeys: KeysFile = {};
        if (this.isRedisReady()) {
            try {
                const redisRaw = await this.redisClient!.hget(redisHashKey, redisHashFields.keys);
                if (redisRaw) {
                    redisKeys = JSON.parse(redisRaw) as KeysFile;
                } else {
                    const legacyRaw = await this.redisClient!.get(legacyRedisKeys.keys);
                    if (legacyRaw) {
                        redisKeys = JSON.parse(legacyRaw) as KeysFile;
                    }
                }
            } catch (err) {
                console.error('[DataManager] Failed reading keys from Redis for sync:', err);
            }
        }

        const merged = this.mergeKeysData(redisKeys, fsKeys);

        try {
            await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (err) {
            console.error('[DataManager] Failed writing merged keys to filesystem:', err);
        }

        if (this.isRedisReady()) {
            try {
                await this.redisClient!.multi()
                    .hset(redisHashKey, redisHashFields.keys, JSON.stringify(merged))
                    .del(legacyRedisKeys.keys)
                    .exec();
            } catch (err) {
                console.error('[DataManager] Failed writing merged keys to Redis:', err);
            }
        }

        inMemoryCache.keys = { value: merged, ts: Date.now() };
        console.log(`[DataManager] Keys sync complete. Total keys: ${Object.keys(merged).length}`);
    }

    public async syncProvidersBetweenRedisAndFilesystem(): Promise<void> {
        const filePath = filePaths.providers;

        let fsProviders: LoadedProviders = [];
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                fsProviders = JSON.parse(raw || '[]') as LoadedProviders;
            }
        } catch (err) {
            console.error('[DataManager] Failed reading providers from filesystem for sync:', err);
        }

        let redisProviders: LoadedProviders = [];
        if (this.isRedisReady()) {
            try {
                const redisRaw = await this.redisClient!.hget(redisHashKey, redisHashFields.providers);
                if (redisRaw) {
                    redisProviders = JSON.parse(redisRaw) as LoadedProviders;
                } else {
                    const legacyRaw = await this.redisClient!.get(legacyRedisKeys.providers);
                    if (legacyRaw) {
                        redisProviders = JSON.parse(legacyRaw) as LoadedProviders;
                    }
                }
            } catch (err) {
                console.error('[DataManager] Failed reading providers from Redis for sync:', err);
            }
        }

        const merged = this.mergeProvidersData(redisProviders, fsProviders);

        try {
            await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (err) {
            console.error('[DataManager] Failed writing merged providers to filesystem:', err);
        }

        if (this.isRedisReady()) {
            try {
                await this.redisClient!.multi()
                    .hset(redisHashKey, redisHashFields.providers, JSON.stringify(merged))
                    .del(legacyRedisKeys.providers)
                    .exec();
            } catch (err) {
                console.error('[DataManager] Failed writing merged providers to Redis:', err);
            }
        }

        inMemoryCache.providers = { value: merged, ts: Date.now() };
        console.log(`[DataManager] Providers sync complete. Total providers: ${merged.length}`);
    }

    private normalizeKeysSchema(keys: KeysFile): { normalized: KeysFile; changed: boolean } {
        let changed = false;
        const normalized: KeysFile = {};

        for (const [apiKey, rawUser] of Object.entries(keys || {})) {
            const user = { ...(rawUser as any) };

            if (typeof user.tokenUsage !== 'number' || Number.isNaN(user.tokenUsage) || user.tokenUsage < 0) {
                user.tokenUsage = 0;
                changed = true;
            }

            if (typeof user.requestCount !== 'number' || Number.isNaN(user.requestCount) || user.requestCount < 0) {
                user.requestCount = 0;
                changed = true;
            }

            if (user.role !== 'admin' && user.role !== 'user') {
                user.role = 'user';
                changed = true;
            }

            if (typeof user.tier !== 'string' || !user.tier) {
                user.tier = 'free';
                changed = true;
            }

            normalized[apiKey] = user as UserData;
        }

        return { normalized, changed };
    }

    private getDataSignature(data: unknown): string {
        try {
            return JSON.stringify(data);
        } catch {
            return '';
        }
    }

    private async syncModelsMirrorIfNeeded(
        modelsData: ModelsFileStructure,
        source: 'redis' | 'filesystem'
    ): Promise<void> {
        const signature = this.getDataSignature(modelsData);
        if (!signature || signature === lastModelsMirrorSignature) {
            return;
        }

        if (source === 'redis') {
            try {
                await fs.promises.writeFile(filePaths.models, JSON.stringify(modelsData, null, 2), 'utf8');
            } catch (err) {
                console.error('[DataManager] Failed syncing models from Redis to filesystem:', err);
                return;
            }
        } else {
            if (!this.isRedisReady()) return;
            try {
                await this.redisClient!.hset(redisHashKey, redisHashFields.models, JSON.stringify(modelsData));
                await this.redisClient!.del(legacyRedisKeys.models);
            } catch (err) {
                console.error('[DataManager] Failed syncing models from filesystem to Redis:', err);
                return;
            }
        }

        lastModelsMirrorSignature = signature;
    }

     public readFile(filePath: string, encoding: BufferEncoding = 'utf8'): string {
         try {
            if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
            return fs.readFileSync(filePath, encoding);
         } catch(err) {
             console.error(`Error reading file ${filePath}:`, err); throw err; 
         }
     }

    async runStartupRedisMigration(): Promise<void> {
        if (!this.isRedisReady()) {
            console.log('[DataManager] Skipping startup Redis migration: Redis client not ready.');
            return;
        }

        try {
            const alreadyMigrated = await this.redisClient!.hget(redisHashKey, redisMigrationMarkerField);
            if (alreadyMigrated === '1') {
                console.log('[DataManager] Startup Redis migration already completed.');
                return;
            }

            const dataTypes: DataType[] = ['providers', 'keys', 'models'];
            let migratedCount = 0;
            let cleanedCount = 0;

            for (const dataType of dataTypes) {
                const redisField = redisHashFields[dataType];
                const legacyRedisKey = legacyRedisKeys[dataType];

                const existingHashValue = await this.redisClient!.hget(redisHashKey, redisField);
                if (!existingHashValue) {
                    const legacyValue = await this.redisClient!.get(legacyRedisKey);
                    if (legacyValue) {
                        await this.redisClient!.hset(redisHashKey, redisField, legacyValue);
                        migratedCount += 1;
                    }
                }

                const deleted = await this.redisClient!.del(legacyRedisKey);
                if (deleted > 0) cleanedCount += deleted;
            }

            await this.redisClient!.hset(redisHashKey, redisMigrationMarkerField, '1');
            console.log(`[DataManager] Startup Redis migration complete. Migrated: ${migratedCount}, legacy keys removed: ${cleanedCount}.`);
        } catch (err) {
            console.error('[DataManager] Startup Redis migration failed:', err);
        }
    }

    async load<T extends ManagedDataStructure>(dataType: DataType): Promise<T> {
        // Serve from warm cache if fresh to avoid hitting Redis for every request and to survive brief Redis hiccups.
        const cached = inMemoryCache[dataType];
        const now = Date.now();
        if (cached && now - cached.ts < CACHE_TTL_MS) {
            return cached.value as T;
        }

        const redisField = redisHashFields[dataType];
        const legacyRedisKey = legacyRedisKeys[dataType];
        const filePath = filePaths[dataType];
        const defaultValue = defaultEmptyData[dataType] as T;
        
        const loadFromRedis = async (): Promise<T | null> => {
            if (!this.isRedisReady()) {
                if (!filesystemFallbackLogged.has(dataType)) {
                    console.log(`DataManager: Redis not ready, cannot load ${dataType} from Redis.`);
                    // No need to add to set here, loadFromFilesystem will log fallback
                }
                return null;
            }
            try {
                const redisData = await withTimeout(
                    this.redisClient!.hget(redisHashKey, redisField),
                    750,
                    `[DataManager] Redis HGET timed out for ${dataType}`
                );
                if (redisData) {
                    console.log(`[DataManager] Data loaded successfully from Redis for: ${dataType}`);
                    return JSON.parse(redisData) as T; 
                }

                const legacyData = await withTimeout(
                    this.redisClient!.get(legacyRedisKey),
                    750,
                    `[DataManager] Redis legacy GET timed out for ${dataType}`
                );
                if (legacyData) {
                    console.log(`[DataManager] Legacy Redis key found for ${dataType}; migrating to hash namespace.`);
                    await this.redisClient!.hset(redisHashKey, redisField, legacyData);
                    await this.redisClient!.del(legacyRedisKey);
                    return JSON.parse(legacyData) as T;
                }

                 console.log(`[DataManager] No data found in Redis for: ${dataType}`);
                return null; // Explicitly return null if key doesn't exist in Redis
            } catch (err) {
                 console.error(`[DataManager] Error loading/parsing from Redis for ${dataType}. Error:`, err);
                 return null;
            }
        };

        const loadFromFilesystem = async (): Promise<T | null> => {
            if (!filesystemFallbackLogged.has(dataType)) {
                // Log fallback only when actually attempting filesystem load *after* Redis potentially wasn't ready/failed
                if (!this.isRedisReady() || dataSourcePreference === 'filesystem') { 
                     console.log(`DataManager: Loading ${dataType} from filesystem.`);
                     filesystemFallbackLogged.add(dataType);
                }
            }
             try {
                 if (fs.existsSync(filePath)) {
                     const fileData = fs.readFileSync(filePath, 'utf8');
                     console.log(`[DataManager] Data loaded successfully from Filesystem for: ${dataType}`);
                     return JSON.parse(fileData) as T;
                 } else {
                     console.warn(`[DataManager] File not found: ${filePath}. Cannot load ${dataType} from filesystem.`);
                     return null;
                 }
             } catch (err) {
                 console.error(`[DataManager] Error loading/parsing file ${filePath}. Error:`, err);
                 return null;
            }
        };

        let loadedData: T | null = null;
        let loadedFromFallback = false; // Flag to indicate if data was loaded from a fallback source
        let loadedSource: 'redis' | 'filesystem' | null = null;

        // Attempt to load based on preference
        if (dataSourcePreference === 'redis') {
            loadedData = await loadFromRedis();
            if (loadedData !== null) loadedSource = 'redis';
            if (loadedData === null) { // If Redis failed or was empty, try filesystem
                console.log(`[DataManager] Redis preferred, but failed/empty for ${dataType}. Trying filesystem.`);
                loadedData = await loadFromFilesystem();
                if (loadedData !== null) {
                    loadedFromFallback = true; // Mark that data was loaded from fallback
                    loadedSource = 'filesystem';
                }
            }
        } else { // Filesystem preference
            loadedData = await loadFromFilesystem();
            if (loadedData !== null) loadedSource = 'filesystem';
            if (loadedData === null) { // If filesystem failed or was empty, try Redis
                console.log(`[DataManager] Filesystem preferred, but failed/empty for ${dataType}. Trying Redis.`);
                loadedData = await loadFromRedis();
                if (loadedData !== null) {
                    loadedFromFallback = true; // Mark that data was loaded from fallback
                    loadedSource = 'redis';
                }
            }
        }

        // If data loaded successfully from either source
        if (loadedData !== null) {
            if (dataType === 'keys') {
                const { normalized, changed } = this.normalizeKeysSchema(loadedData as KeysFile);
                if (changed) {
                    loadedData = normalized as T;
                    try {
                        await this.save<T>('keys', loadedData);
                    } catch (err) {
                        console.error('[DataManager] Failed persisting migrated keys schema:', err);
                    }
                }
            }

            if (dataType === 'models' && loadedSource) {
                await this.syncModelsMirrorIfNeeded(loadedData as ModelsFileStructure, loadedSource);
            }

            // If data was loaded from a fallback, save it back to ensure sync with the preferred source
            if (loadedFromFallback) {
                console.log(`[DataManager] Data for ${dataType} loaded from fallback. Attempting to save back to synchronize sources.`);
                try {
                    // Intentionally not awaiting this promise to avoid blocking the load operation,
                    // but logging success/failure.
                    // The save operation itself handles logging.
                    this.save(dataType, loadedData).catch(saveErr => {
                         console.error(`[DataManager] Asynchronous save after fallback for ${dataType} failed:`, saveErr);
                    });
                } catch (saveErr) {
                    // This catch block might be redundant if `this.save` doesn't throw synchronously
                    // when the promise is not awaited, but kept for safety.
                    console.error(`[DataManager] Error initiating save for ${dataType} back after fallback load:`, saveErr);
                }
            }
            // Update cache on successful load
            inMemoryCache[dataType] = { value: loadedData, ts: Date.now() };
            return loadedData;
        }

        // If data is null after trying both sources, handle default case
        console.warn(`[DataManager] Data for ${dataType} not found in ${dataSourcePreference} or fallback source. Using/creating default.`);
        // Save the default value to both places to initialize
        try {
             await this.save(dataType, defaultValue); // save handles writing to both
        } catch (saveErr) {
            console.error(`[DataManager] CRITICAL: Failed to save default value for ${dataType} during initial load. Error:`, saveErr);
        }
        // Cache the default as well to avoid thrashing repeated fallbacks
        inMemoryCache[dataType] = { value: defaultValue, ts: Date.now() };
        return defaultValue;
    }

    /**
     * Atomic read-modify-write against Redis when available. Falls back to load/save
     * (non-atomic) if Redis is unavailable or contention persists.
     */
    async updateWithLock<T extends ManagedDataStructure>(
        dataType: DataType,
        updater: (current: T) => T | Promise<T>,
        maxRetries = 3
    ): Promise<T> {
        const redisField = redisHashFields[dataType];
        const legacyRedisKey = legacyRedisKeys[dataType];

        if (this.isRedisReady()) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    await this.redisClient!.watch(redisHashKey);
                    let currentRaw = await this.redisClient!.hget(redisHashKey, redisField);
                    if (!currentRaw) {
                        currentRaw = await this.redisClient!.get(legacyRedisKey);
                    }

                    const currentData = currentRaw ? (JSON.parse(currentRaw) as T) : (defaultEmptyData[dataType] as T);
                    const updated = await updater(this.cloneData(currentData));

                    const tx = this.redisClient!.multi();
                    tx.hset(redisHashKey, redisField, JSON.stringify(updated));
                    tx.del(legacyRedisKey);
                    const execResult = await tx.exec();
                    if (execResult !== null) {
                        inMemoryCache[dataType] = { value: updated, ts: Date.now() };

                        return updated;
                    }
                } catch (err) {
                    console.warn(`[DataManager] Redis updateWithLock attempt ${attempt + 1} failed for ${dataType}:`, err);
                } finally {
                    try { await this.redisClient!.unwatch(); } catch { /* ignore */ }
                }
            }
            console.warn(`[DataManager] Falling back to filesystem update for ${dataType} after Redis contention.`);
        }

        const current = await this.load<T>(dataType);
        const updated = await updater(this.cloneData(current));
        await this.save<T>(dataType, updated);
        return updated;
    }

    async save<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        // Safety guard: never overwrite providers.json with an empty array
        if (dataType === 'providers' && Array.isArray(data) && data.length === 0) {
            console.error('[DataManager] Refusing to save providers.json because data array is empty. Aborting save to prevent destruction.');
            return;
        }

        const redisField = redisHashFields[dataType];
        const legacyRedisKey = legacyRedisKeys[dataType];
        const filePath = filePaths[dataType];
        let redisStringifiedData: string;
        let fileStringifiedData: string;

        try {
             if (data === null || typeof data !== 'object') throw new Error(`Invalid data type for ${dataType}: ${typeof data}`);
            redisStringifiedData = JSON.stringify(data);
            fileStringifiedData = JSON.stringify(data, null, 2);
        } catch (err) { 
            console.error(`[DataManager] Error stringifying data for ${dataType}. Aborting save. Error:`, err);
            // Optionally log to error logger
            // await logError({ message: `Data serialization failed for ${dataType}`, error: err }); 
            return; 
        }

        let redisSuccess = false;
        let fsSuccess = false;

        const redisSavePromise = (async () => {
            if (!this.isRedisReady()) {
                if (!filesystemFallbackLogged.has(dataType)) {
                    console.log(`DataManager: Redis not ready. Cannot save ${dataType} to Redis.`);
                }
                if (dataSourcePreference === 'redis') {
                    console.error(`[DataManager] CRITICAL: Cannot save to preferred source (Redis) for ${dataType} - Client not ready.`);
                }
                return;
            }

            try {
                await this.redisClient!.multi()
                    .hset(redisHashKey, redisField, redisStringifiedData)
                    .del(legacyRedisKey)
                    .exec();
                redisSuccess = true;
                console.log(`[DataManager] Data saved successfully to Redis for: ${dataType}`);
            } catch (err) {
                console.error(`[DataManager] Error saving to Redis hash for ${dataType}. Error:`, err);
                if (dataSourcePreference === 'redis') {
                    console.error(`[DataManager] CRITICAL: Failed to save to preferred source (Redis) for ${dataType}.`);
                }
            }
        })();

        const fsSavePromise = (async () => {
            try {
                await fs.promises.writeFile(filePath, fileStringifiedData, 'utf8');
                fsSuccess = true;
                console.log(`[DataManager] Data saved successfully to Filesystem for: ${dataType}`);
            } catch (err) {
                console.error(`[DataManager] Error saving to file ${filePath}. Error:`, err);
                if (dataSourcePreference === 'filesystem') {
                    console.error(`[DataManager] CRITICAL: Failed to save to preferred source (Filesystem) for ${dataType}.`);
                }
            }
        })();

        await Promise.all([redisSavePromise, fsSavePromise]);

        // Final status log
        if (!redisSuccess && !fsSuccess) {
            console.error(`[DataManager] !!! Data Save FAILED for ${dataType} on BOTH Redis and Filesystem !!!`);
        } else if (!redisSuccess && dataSourcePreference === 'redis') {
            console.warn(`[DataManager] WARNING: Saved ${dataType} to Filesystem, but FAILED to save to preferred source (Redis).`);
        } else if (!fsSuccess && dataSourcePreference === 'filesystem') {
             console.warn(`[DataManager] WARNING: Saved ${dataType} to Redis, but FAILED to save to preferred source (Filesystem).`);
        }

    }
}

export const dataManager = new DataManager(redis); 
export function isDataManagerReady(): boolean { return true; }
