import fs from 'fs';
import path from 'path';
import redis, { redisReadyPromise, Redis } from './db.js'; 

const BunRuntime = (globalThis as any).Bun;
const HAS_BUN_FILE_IO = typeof BunRuntime?.file === 'function' && typeof BunRuntime?.write === 'function';

function createEnoentError(filePath: string): NodeJS.ErrnoException {
    const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = 'open';
    err.path = filePath;
    return err;
}

async function readTextFile(filePath: string): Promise<string> {
    if (HAS_BUN_FILE_IO) {
        const file = BunRuntime.file(filePath);
        const size = typeof file?.size === 'number' ? file.size : 0;
        if (size === 0) {
            const exists = typeof file?.exists === 'function'
                ? await file.exists()
                : fs.existsSync(filePath);
            if (!exists) throw createEnoentError(filePath);
        }
        return await file.text();
    }
    return await fs.promises.readFile(filePath, 'utf8');
}

async function writeTextFile(filePath: string, contents: string): Promise<void> {
    if (HAS_BUN_FILE_IO) {
        await BunRuntime.write(filePath, contents);
        return;
    }
    await fs.promises.writeFile(filePath, contents, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
    if (HAS_BUN_FILE_IO) {
        const file = BunRuntime.file(filePath);
        if (typeof file?.exists === 'function') {
            return await file.exists();
        }
        const size = typeof file?.size === 'number' ? file.size : 0;
        if (size > 0) return true;
        return fs.existsSync(filePath);
    }
    return fs.existsSync(filePath);
}

async function ensureDir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
}

async function copyFileCompat(sourcePath: string, targetPath: string): Promise<void> {
    if (HAS_BUN_FILE_IO) {
        const sourceFile = BunRuntime.file(sourcePath);
        const exists = await fileExists(sourcePath);
        if (!exists) throw createEnoentError(sourcePath);
        await BunRuntime.write(targetPath, sourceFile);
        return;
    }
    await fs.promises.copyFile(sourcePath, targetPath);
}

async function renameFileCompat(sourcePath: string, targetPath: string): Promise<void> {
    await fs.promises.rename(sourcePath, targetPath);
}

async function unlinkFileCompat(filePath: string): Promise<void> {
    await fs.promises.unlink(filePath);
}

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
    rate_limit_rps?: number | null;
    rate_limit_requests?: number | null;
    rate_limit_window_ms?: number | null;
    capability_skips?: Record<string, string>;
    disabled?: boolean;
    disabled_at?: number; // Epoch ms when the model was disabled (for time-based auto-recovery)
    disable_count?: number; // How many times this model has been disabled (for exponential backoff)
}

// FIX: Add export
export interface LoadedProviderData { 
    id: string; 
    apiKey: string | null; // Make consistent with Provider interface
    provider_url: string; // Make required, consistent with Provider interface
    provider_urls?: { [modelId: string]: string };
    provider?: string;
    type?: string;
    native_family?: string;
    native_protocol?: string;
    streamingCompatible?: boolean;
    models: { [key: string]: ProviderModelData };
    disabled: boolean; // Make required with default false
    avg_response_time: number | null;
    avg_provider_latency: number | null;
    errors: number;
    provider_score: number | null;
    lastError?: string;
    lastErrorCode?: string;
    lastStatus?: number | null;
    lastErrorAt?: number;
    disabled_reason?: string;
}
// FIX: Add export
export type LoadedProviders = LoadedProviderData[];

// FIX: Add export (if UserData/KeysFile are defined here and needed elsewhere)
// Or ensure they are exported from userData.ts if defined there
export interface UserData {
    userId: string;
    tokenUsage: number;
    requestCount: number;
    dailyRequestCount?: number;
    dailyRequestDate?: string;
    role: 'admin' | 'user';
    tier: string;
    estimatedCost?: number;
    paidTokenUsage?: number;
    paidRequestCount?: number;
    paidEstimatedCost?: number;
    billingPeriodStartedAt?: string;
    lastBillingSettlementAt?: string;
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
    active_providers?: number;
    known_providers?: number;
    cooling_down_providers?: number;
    temporarily_unavailable_providers?: number;
    throughput?: number | null;
    capabilities?: string[];
}
// FIX: Add export
export interface ModelsFileStructure { object: string; data: ModelDefinition[]; }

// --- Type Definitions for DataManager ---
type DataType = 'providers' | 'keys' | 'models';
type ManagedDataStructure = LoadedProviders | KeysFile | ModelsFileStructure;

// --- Configuration ---
function resolveManagedDataFilePath(envVarName: string, defaultFileName: string): string {
    const override = process.env[envVarName];
    if (typeof override === 'string' && override.trim().length > 0) {
        return path.resolve(override.trim());
    }
    return path.resolve(defaultFileName);
}

const filePaths: Record<DataType, string> = {
    providers: resolveManagedDataFilePath('API_PROVIDERS_FILE', 'providers.json'),
    keys: resolveManagedDataFilePath('API_KEYS_FILE', 'keys.json'),
    models: resolveManagedDataFilePath('API_MODELS_FILE', 'models.json'),
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
const CACHE_TTL_MS = Math.max(
    0,
    Number(
        process.env.DATA_CACHE_TTL_MS ??
            (process.env.NODE_ENV === 'test' ? '0' : '5000')
    )
); // keep data warm for a few seconds between requests (disabled in tests)

// Utility: wrap an async call with a timeout to avoid hanging on slow Redis responses.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms);
        promise
            .then((val) => { clearTimeout(timer); resolve(val); })
            .catch((err) => { clearTimeout(timer); reject(err); });
    });
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
const defaultEmptyData: Record<DataType, any> = {
    providers: [],
    keys: {},
    models: { object: 'list', data: [] },
};
let lastModelsMirrorSignature: string | null = null;

async function backupInvalidKeysJson(filePath: string, error: unknown): Promise<void> {
    try {
        if (!(await fileExists(filePath))) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${filePath}.invalid-${timestamp}.bak`;
        await copyFileCompat(filePath, backupPath);
        console.warn(`[DataManager] Backed up invalid keys.json to ${backupPath}.`);
    } catch (backupError) {
        console.error(`[DataManager] Failed to back up invalid keys.json (${filePath}):`, backupError);
    }
    console.error(`[DataManager] Invalid JSON in ${filePath}. Skipping overwrite to avoid data loss.`, error);
}

const dataTmpDir = (process.env.DATA_TMP_DIR ?? '').trim() || '.tmp';
const resolvedDataTmpDir = path.resolve(dataTmpDir);
let dataTmpDirEnsured = false;
let dataTmpDirUnavailable = false;

async function ensureTmpDirExists(): Promise<string | null> {
    if (dataTmpDirUnavailable) return null;
    if (dataTmpDirEnsured) return resolvedDataTmpDir;
    try {
        await ensureDir(resolvedDataTmpDir);
        dataTmpDirEnsured = true;
        return resolvedDataTmpDir;
    } catch (err) {
        if (!dataTmpDirUnavailable) {
            console.error(`[DataManager] Failed to ensure DATA_TMP_DIR (${resolvedDataTmpDir}); falling back to in-place tmp files.`, err);
        }
        dataTmpDirUnavailable = true;
        return null;
    }
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
    const tmpDir = await ensureTmpDirExists();
    const tmpPath = tmpDir
        ? path.join(tmpDir, `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
        : `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await writeTextFile(tmpPath, contents);
        try {
            await renameFileCompat(tmpPath, filePath);
        } catch (err: any) {
            if (err?.code === 'EXDEV') {
                await copyFileCompat(tmpPath, filePath);
                await unlinkFileCompat(tmpPath);
            } else {
                throw err;
            }
        }
    } catch (err) {
        try {
            await unlinkFileCompat(tmpPath);
        } catch {
            // ignore cleanup errors
        }
        throw err;
    }
}

// Set to track if filesystem fallback has been logged for a dataType
const filesystemFallbackLogged = new Set<DataType>();

const keysFilesystemSyncIntervalMs = Math.max(
    0,
    Number(process.env.KEYS_FS_SYNC_INTERVAL_MS ?? '3000') || 3000
);

const pendingFsWrites = new Map<DataType, { timer: NodeJS.Timeout; data: string; filePath: string }>();

// Prefer Redis by default when available; allow forcing filesystem via env.
const dataSourcePreference: 'redis' | 'filesystem' = process.env.DATA_SOURCE_PREFERENCE === 'filesystem' ? 'filesystem' : 'redis';
console.log(`[DataManager] Data source preference set to: ${dataSourcePreference}`);

const redisReadTimeoutMs = Math.max(
    100,
    Number(process.env.REDIS_READ_TIMEOUT_MS ?? '750') || 750
);

const keysRedisReadTimeoutMs = Math.max(
    100,
    Number(process.env.KEYS_REDIS_READ_TIMEOUT_MS ?? redisReadTimeoutMs) || redisReadTimeoutMs
);

const redisFailureCooldownMs = Math.max(
    0,
    Number(process.env.REDIS_FAILURE_COOLDOWN_MS ?? '3000') || 3000
);

// --- DataManager Class ---
class DataManager {
    private redisClient: Redis | null;
    private pendingRedisBackfill = new Set<DataType>();
    private redisBackfillPromise: Promise<void> | null = null;
    private inFlightLoads = new Map<DataType, Promise<ManagedDataStructure>>();
    private redisReadCooldownUntil = new Map<DataType, number>();

    constructor(redisInstance: Redis | null) {
        this.redisClient = redisInstance;
        if (this.redisClient) {
             this.redisClient.on('ready', () => console.log("DataManager: Redis client ready."));
             this.redisClient.on('error', (err) => console.error("DataManager: Redis client error:", err));
             console.log(`DataManager initialized with Redis client (${this.redisClient.status}).`);
             this.attachRedisReadyHandler();
        } else {
            console.log("DataManager initialized without Redis client (using filesystem only).");
        }
    }

    private isRedisReady(): boolean {
        return !!this.redisClient && this.redisClient.status === 'ready'; 
    }

    public isReady(): boolean {
        return !this.redisClient || this.isRedisReady();
    }

    private attachRedisReadyHandler(): void {
        if (!redisReadyPromise) return;
        redisReadyPromise
            .then(() => this.backfillPendingToRedis('ready-event'))
            .catch(() => {
                // Redis not available; fallback to filesystem continues.
            });
    }

    public async waitForRedisReadyAndBackfill(): Promise<void> {
        if (!redisReadyPromise) return;
        await redisReadyPromise;
        await this.backfillPendingToRedis('explicit-wait');
    }

    private async getCachedOrFilesystem<T extends ManagedDataStructure>(dataType: DataType): Promise<T | null> {
        const cached = inMemoryCache[dataType];
        if (cached?.value) return cached.value as T;

        const filePath = filePaths[dataType];
        try {
            const fileData = await readTextFile(filePath);
            return JSON.parse(fileData) as T;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                console.error(`[DataManager] Failed reading ${dataType} from filesystem for Redis backfill:`, err);
            }
            return null;
        }
    }

    private async saveToRedisOnly<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        if (!this.isRedisReady()) return;

        if (dataType === 'providers' && Array.isArray(data) && data.length === 0) {
            console.warn('[DataManager] Skipping Redis backfill for providers because data array is empty.');
            return;
        }

        try {
            const redisStringifiedData = JSON.stringify(data);
            const redisField = redisHashFields[dataType];
            const legacyRedisKey = legacyRedisKeys[dataType];
            await this.redisClient!.hset(redisHashKey, redisField, redisStringifiedData);
            await this.redisClient!.del(legacyRedisKey);
            console.log(`[DataManager] Redis backfill saved for: ${dataType}`);
        } catch (err) {
            console.error(`[DataManager] Redis backfill failed for ${dataType}:`, err);
        }
    }

    private async backfillPendingToRedis(reason: string): Promise<void> {
        if (!this.isRedisReady()) return;
        if (this.redisBackfillPromise) return this.redisBackfillPromise;

        this.redisBackfillPromise = (async () => {
            const pendingTypes = Array.from(this.pendingRedisBackfill);
            const targets = pendingTypes.filter((t) => t === 'models' || t === 'providers');
            if (targets.length === 0) return;

            console.log(`[DataManager] Redis ready; backfilling pending data (${targets.join(', ')}) [${reason}]...`);

            if (targets.includes('models')) {
                const modelsData = await this.getCachedOrFilesystem<ModelsFileStructure>('models');
                if (modelsData) {
                    await this.syncModelsMirrorIfNeeded(modelsData, 'filesystem');
                    inMemoryCache.models = { value: modelsData, ts: Date.now() };
                } else {
                    console.warn('[DataManager] No models data available for Redis backfill.');
                }
                this.pendingRedisBackfill.delete('models');
            }

            if (targets.includes('providers')) {
                const providersData = await this.getCachedOrFilesystem<LoadedProviders>('providers');
                if (providersData) {
                    await this.saveToRedisOnly('providers', providersData);
                    inMemoryCache.providers = { value: providersData, ts: Date.now() };
                } else {
                    console.warn('[DataManager] No providers data available for Redis backfill.');
                }
                this.pendingRedisBackfill.delete('providers');
            }
        })().finally(() => {
            this.redisBackfillPromise = null;
        });

        return this.redisBackfillPromise;
    }

    private cloneData<T extends ManagedDataStructure>(data: T): T {
        return JSON.parse(JSON.stringify(data));
    }

    private mergeKeyRecords(a?: Partial<UserData>, b?: Partial<UserData>): UserData {
        const roleA = a?.role === 'admin' ? 'admin' : (a?.role === 'user' ? 'user' : undefined);
        const roleB = b?.role === 'admin' ? 'admin' : (b?.role === 'user' ? 'user' : undefined);
        const toNumber = (value: unknown): number | undefined => {
            const num = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(num) ? num : undefined;
        };
        const redisTokenUsage = toNumber(b?.tokenUsage);
        const fsTokenUsage = toNumber(a?.tokenUsage);
        const redisRequestCount = toNumber(b?.requestCount);
        const fsRequestCount = toNumber(a?.requestCount);

        const merged: UserData = {
            userId: (typeof b?.userId === 'string' && b.userId) ? b.userId : ((typeof a?.userId === 'string' && a.userId) ? a.userId : 'unknown_user'),
            tokenUsage: Math.max(0, redisTokenUsage ?? fsTokenUsage ?? 0),
            requestCount: Math.max(0, redisRequestCount ?? fsRequestCount ?? 0),
            role: roleB || roleA || 'user',
            tier: (typeof b?.tier === 'string' && b.tier) ? b.tier : ((typeof a?.tier === 'string' && a.tier) ? a.tier : 'free'),
        };
        const costB = typeof b?.estimatedCost === 'number' ? b.estimatedCost : undefined;
        const costA = typeof a?.estimatedCost === 'number' ? a.estimatedCost : undefined;
        if (costB !== undefined || costA !== undefined) {
            merged.estimatedCost = costB ?? costA;
        }
        return merged;
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
        const capabilitySkipsRaw = raw?.capability_skips;
        const capabilitySkips = (capabilitySkipsRaw && typeof capabilitySkipsRaw === 'object')
            ? Object.fromEntries(
                Object.entries(capabilitySkipsRaw as Record<string, unknown>)
                    .filter(([_, value]) => typeof value === 'string' && value.trim())
                    .map(([key, value]) => [key, String(value)])
              )
            : undefined;
        const disabled_at = typeof (raw as any)?.disabled_at === 'number' && (raw as any).disabled_at > 0
            ? (raw as any).disabled_at
            : undefined;
        const disable_count = typeof (raw as any)?.disable_count === 'number' && (raw as any).disable_count >= 0
            ? Math.floor((raw as any).disable_count)
            : undefined;
        const rateLimitRps = typeof (raw as any)?.rate_limit_rps === 'number' && Number.isFinite((raw as any).rate_limit_rps)
            ? Math.max(0, Number((raw as any).rate_limit_rps))
            : null;
        return {
            id: typeof raw?.id === 'string' && raw.id ? raw.id : modelId,
            token_generation_speed: typeof raw?.token_generation_speed === 'number' && !Number.isNaN(raw.token_generation_speed) ? raw.token_generation_speed : 50,
            response_times: responseTimes,
            errors: typeof raw?.errors === 'number' && !Number.isNaN(raw.errors) ? Math.max(0, raw.errors) : 0,
            consecutive_errors: typeof raw?.consecutive_errors === 'number' && !Number.isNaN(raw.consecutive_errors) ? Math.max(0, raw.consecutive_errors) : 0,
            avg_response_time: typeof raw?.avg_response_time === 'number' ? raw.avg_response_time : null,
            avg_provider_latency: typeof raw?.avg_provider_latency === 'number' ? raw.avg_provider_latency : null,
            avg_token_speed: typeof raw?.avg_token_speed === 'number' ? raw.avg_token_speed : null,
            rate_limit_rps: rateLimitRps,
            capability_skips: capabilitySkips && Object.keys(capabilitySkips).length ? capabilitySkips : undefined,
            disabled: Boolean((raw as any)?.disabled),
            ...(disabled_at !== undefined ? { disabled_at } : {}),
            ...(disable_count !== undefined ? { disable_count } : {}),
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
        const mergedSkips = {
            ...(normalizedFs.capability_skips || {}),
            ...(normalizedRedis.capability_skips || {}),
        };
        const mergedRateLimitRps = normalizedRedis.rate_limit_rps ?? normalizedFs.rate_limit_rps ?? null;
        const preferredModel = dataSourcePreference === 'redis' ? normalizedRedis : normalizedFs;
        const fallbackModel = preferredModel === normalizedRedis ? normalizedFs : normalizedRedis;
        const mergedDisabled = Boolean(preferredModel.disabled);
        const mergedDisabledAt = mergedDisabled
            ? (preferredModel.disabled_at ?? fallbackModel.disabled_at)
            : undefined;
        const mergedDisableCount = mergedDisabled
            ? (preferredModel.disable_count ?? fallbackModel.disable_count)
            : undefined;
        return {
            id: normalizedRedis.id || normalizedFs.id || modelId,
            token_generation_speed: Math.max(1, normalizedRedis.token_generation_speed || normalizedFs.token_generation_speed || 50),
            response_times: this.mergeResponseTimes(normalizedFs.response_times, normalizedRedis.response_times),
            errors: Math.max(normalizedFs.errors, normalizedRedis.errors),
            consecutive_errors: Math.max(normalizedFs.consecutive_errors, normalizedRedis.consecutive_errors),
            avg_response_time: normalizedRedis.avg_response_time ?? normalizedFs.avg_response_time,
            avg_provider_latency: normalizedRedis.avg_provider_latency ?? normalizedFs.avg_provider_latency,
            avg_token_speed: normalizedRedis.avg_token_speed ?? normalizedFs.avg_token_speed,
            rate_limit_rps: mergedRateLimitRps,
            capability_skips: Object.keys(mergedSkips).length ? mergedSkips : undefined,
            disabled: mergedDisabled,
            ...(mergedDisabledAt !== undefined ? { disabled_at: mergedDisabledAt } : {}),
            ...(mergedDisableCount !== undefined ? { disable_count: mergedDisableCount } : {}),
        };
    }

    private normalizeProviderData(raw: Partial<LoadedProviderData> | undefined, providerId: string): LoadedProviderData {
        const models: { [key: string]: ProviderModelData } = {};
        const rawModels = raw?.models || {};
        for (const [modelId, modelData] of Object.entries(rawModels)) {
            models[modelId] = this.normalizeProviderModelData(modelData as Partial<ProviderModelData>, modelId);
        }

        const lastErrorRaw = typeof (raw as any)?.lastError === 'string'
            ? (raw as any).lastError
            : (typeof (raw as any)?.last_error === 'string' ? (raw as any).last_error : undefined);
        const lastError = typeof lastErrorRaw === 'string' && lastErrorRaw.trim().length > 0
            ? lastErrorRaw.slice(0, 4000)
            : undefined;
        const lastErrorCodeRaw = typeof (raw as any)?.lastErrorCode === 'string'
            ? (raw as any).lastErrorCode
            : (typeof (raw as any)?.last_error_code === 'string' ? (raw as any).last_error_code : undefined);
        const lastErrorCode = typeof lastErrorCodeRaw === 'string' && lastErrorCodeRaw.trim().length > 0
            ? lastErrorCodeRaw.slice(0, 200)
            : undefined;
        const lastStatusRaw = typeof (raw as any)?.lastStatus === 'number'
            ? (raw as any).lastStatus
            : (typeof (raw as any)?.last_status === 'number' ? (raw as any).last_status : null);
        const lastStatus = typeof lastStatusRaw === 'number' && Number.isFinite(lastStatusRaw) && lastStatusRaw > 0
            ? Math.floor(lastStatusRaw)
            : null;
        const lastErrorAtRaw = typeof (raw as any)?.lastErrorAt === 'number'
            ? (raw as any).lastErrorAt
            : (typeof (raw as any)?.last_error_at === 'number' ? (raw as any).last_error_at : undefined);
        const lastErrorAt = typeof lastErrorAtRaw === 'number' && Number.isFinite(lastErrorAtRaw) && lastErrorAtRaw > 0
            ? Math.floor(lastErrorAtRaw)
            : undefined;
        const disabledReasonRaw = typeof (raw as any)?.disabled_reason === 'string'
            ? (raw as any).disabled_reason
            : (typeof (raw as any)?.disabledReason === 'string' ? (raw as any).disabledReason : undefined);
        const disabled_reason = typeof disabledReasonRaw === 'string' && disabledReasonRaw.trim().length > 0
            ? disabledReasonRaw.slice(0, 4000)
            : undefined;

        return {
            id: typeof raw?.id === 'string' && raw.id ? raw.id : providerId,
            apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : null,
            provider_url: typeof raw?.provider_url === 'string' ? raw.provider_url : '',
            provider_urls: typeof raw?.provider_urls === 'object' && raw.provider_urls ? (raw.provider_urls as { [modelId: string]: string }) : undefined,
            streamingCompatible: typeof raw?.streamingCompatible === 'boolean' ? raw.streamingCompatible : undefined,
            models,
            disabled: Boolean(raw?.disabled),
            avg_response_time: typeof raw?.avg_response_time === 'number' ? raw.avg_response_time : null,
            avg_provider_latency: typeof raw?.avg_provider_latency === 'number' ? raw.avg_provider_latency : null,
            errors: typeof raw?.errors === 'number' && !Number.isNaN(raw.errors) ? Math.max(0, raw.errors) : 0,
            provider_score: typeof raw?.provider_score === 'number' ? raw.provider_score : null,
            ...(lastError ? { lastError } : {}),
            ...(lastErrorCode ? { lastErrorCode } : {}),
            ...(lastStatus !== null ? { lastStatus } : {}),
            ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
            ...(disabled_reason ? { disabled_reason } : {}),
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
            const hasRedisProvider = redisMap.has(providerId);
            const baseFs = this.normalizeProviderData(fsProvider, providerId);
            const baseRedis = this.normalizeProviderData(redisProvider, providerId);
            const fsLastErrorAt = typeof baseFs.lastErrorAt === 'number' ? baseFs.lastErrorAt : 0;
            const redisLastErrorAt = typeof baseRedis.lastErrorAt === 'number' ? baseRedis.lastErrorAt : 0;
            const latestErrorSource = redisLastErrorAt >= fsLastErrorAt ? baseRedis : baseFs;
            const fallbackErrorSource = latestErrorSource === baseRedis ? baseFs : baseRedis;
            const mergedLastErrorAt = Math.max(fsLastErrorAt, redisLastErrorAt) || undefined;
            const preferredDisabledSource =
                dataSourcePreference === 'redis' && hasRedisProvider
                    ? baseRedis
                    : hasFilesystemProvider
                        ? baseFs
                        : baseRedis;
            const secondaryDisabledSource =
                preferredDisabledSource === baseRedis ? baseFs : baseRedis;
            const mergedDisabled = Boolean(preferredDisabledSource.disabled);
            const mergedDisabledReason = mergedDisabled
                ? preferredDisabledSource.disabled_reason || secondaryDisabledSource.disabled_reason
                : undefined;
            const mergedErrorFields = mergedLastErrorAt !== undefined
                ? latestErrorSource
                : {
                    lastError: latestErrorSource.lastError || fallbackErrorSource.lastError,
                    lastErrorCode: latestErrorSource.lastErrorCode || fallbackErrorSource.lastErrorCode,
                    lastStatus: latestErrorSource.lastStatus ?? fallbackErrorSource.lastStatus,
                    disabled_reason: mergedDisabledReason,
                };

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
                provider_urls: baseRedis.provider_urls || baseFs.provider_urls,
                streamingCompatible: typeof baseRedis.streamingCompatible === 'boolean' ? baseRedis.streamingCompatible : baseFs.streamingCompatible,
                models: mergedModels,
                disabled: mergedDisabled,
                avg_response_time: baseRedis.avg_response_time ?? baseFs.avg_response_time,
                avg_provider_latency: baseRedis.avg_provider_latency ?? baseFs.avg_provider_latency,
                errors: Math.max(baseFs.errors || 0, baseRedis.errors || 0),
                provider_score: baseRedis.provider_score ?? baseFs.provider_score,
                ...((mergedErrorFields.lastError)
                    ? { lastError: mergedErrorFields.lastError }
                    : {}),
                ...((mergedErrorFields.lastErrorCode)
                    ? { lastErrorCode: mergedErrorFields.lastErrorCode }
                    : {}),
                ...(((mergedErrorFields.lastStatus) !== null
                    && (mergedErrorFields.lastStatus) !== undefined)
                    ? { lastStatus: mergedErrorFields.lastStatus }
                    : {}),
                ...(mergedLastErrorAt !== undefined ? { lastErrorAt: mergedLastErrorAt } : {}),
                ...((mergedDisabledReason)
                    ? { disabled_reason: mergedErrorFields.disabled_reason }
                    : {}),
            });
        }

        merged.sort((a, b) => a.id.localeCompare(b.id));
        return merged;
    }

    public async syncKeysBetweenRedisAndFilesystem(): Promise<void> {
        const filePath = filePaths.keys;

        let fsKeys: KeysFile = {};
        let fsInvalid = false;
        try {
            const raw = await readTextFile(filePath);
            fsKeys = JSON.parse(raw || '{}') as KeysFile;
        } catch (err: any) {
            const isMissing = err?.code === 'ENOENT';
            if (!isMissing) {
                await backupInvalidKeysJson(filePath, err);
                fsInvalid = true;
            }
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

        const hasRedisKeys = Object.keys(redisKeys).length > 0;
        const hasFsKeys = Object.keys(fsKeys).length > 0;

        if (!hasRedisKeys && !hasFsKeys) {
            console.warn('[DataManager] Keys sync skipped: both filesystem and Redis keys are empty.');
            return;
        }

        if (fsInvalid && !hasRedisKeys) {
            console.warn('[DataManager] Keys sync skipped: filesystem keys are invalid and Redis has no keys.');
            return;
        }

        const merged = hasRedisKeys
            ? this.normalizeKeysSchema(redisKeys).normalized
            : this.normalizeKeysSchema(fsKeys).normalized;

        try {
            await writeFileAtomic(filePath, JSON.stringify(merged, null, 2));
        } catch (err) {
            console.error('[DataManager] Failed writing merged keys to filesystem:', err);
        }

        if (this.isRedisReady()) {
            try {
                await this.redisClient!.hset(redisHashKey, redisHashFields.keys, JSON.stringify(merged));
                await this.redisClient!.del(legacyRedisKeys.keys);
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
            const raw = await readTextFile(filePath);
            fsProviders = JSON.parse(raw || '[]') as LoadedProviders;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                console.error('[DataManager] Failed reading providers from filesystem for sync:', err);
            }
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
            await writeFileAtomic(filePath, JSON.stringify(merged, null, 2));
        } catch (err) {
            console.error('[DataManager] Failed writing merged providers to filesystem:', err);
        }

        if (this.isRedisReady()) {
            try {
                await this.redisClient!.hset(redisHashKey, redisHashFields.providers, JSON.stringify(merged));
                await this.redisClient!.del(legacyRedisKeys.providers);
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
        const nowIso = new Date().toISOString();
        const nowDayBucket = nowIso.slice(0, 10);
        const isValidTimestamp = (value: unknown): value is string =>
            typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
        const isValidDayBucket = (value: unknown): value is string =>
            typeof value === 'string'
            && /^\d{4}-\d{2}-\d{2}$/.test(value)
            && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
        const normalizeCounter = (value: unknown): number => {
            const num = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };
        const normalizeCost = (value: unknown): number => {
            const num = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(num) || num < 0) return 0;
            return Math.round(num * 1_000_000) / 1_000_000;
        };

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

            if (typeof user.dailyRequestCount !== 'undefined') {
                const normalizedDailyRequestCount = normalizeCounter(user.dailyRequestCount);
                if (normalizedDailyRequestCount !== user.dailyRequestCount) {
                    user.dailyRequestCount = normalizedDailyRequestCount;
                    changed = true;
                }
            }

            if (typeof user.dailyRequestDate !== 'undefined' && !isValidDayBucket(user.dailyRequestDate)) {
                user.dailyRequestDate = nowDayBucket;
                user.dailyRequestCount = 0;
                changed = true;
            }

            if (typeof user.dailyRequestCount !== 'undefined' && typeof user.dailyRequestDate === 'undefined') {
                user.dailyRequestDate = nowDayBucket;
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

            if (typeof user.estimatedCost !== 'undefined') {
                const normalizedEstimatedCost = normalizeCost(user.estimatedCost);
                if (normalizedEstimatedCost !== user.estimatedCost) {
                    user.estimatedCost = normalizedEstimatedCost;
                    changed = true;
                }
            }

            const totalTokenUsage = normalizeCounter(user.tokenUsage);
            const totalRequestCount = normalizeCounter(user.requestCount);
            const totalEstimatedCost = typeof user.estimatedCost === 'number'
                ? normalizeCost(user.estimatedCost)
                : 0;
            const hasExplicitBillingState =
                typeof user.paidTokenUsage !== 'undefined'
                || typeof user.paidRequestCount !== 'undefined'
                || typeof user.paidEstimatedCost !== 'undefined'
                || typeof user.billingPeriodStartedAt !== 'undefined'
                || typeof user.lastBillingSettlementAt !== 'undefined';

            if (!hasExplicitBillingState) {
                // Treat historical totals as already settled so enabling pay-as-you-go
                // billing does not retroactively mark old usage as unpaid.
                user.paidTokenUsage = totalTokenUsage;
                user.paidRequestCount = totalRequestCount;
                user.paidEstimatedCost = totalEstimatedCost;
                user.billingPeriodStartedAt = nowIso;
                user.lastBillingSettlementAt = nowIso;
                changed = true;
            } else {
                const normalizedPaidTokenUsage = Math.min(
                    totalTokenUsage,
                    normalizeCounter(user.paidTokenUsage)
                );
                if (normalizedPaidTokenUsage !== user.paidTokenUsage) {
                    user.paidTokenUsage = normalizedPaidTokenUsage;
                    changed = true;
                }

                const normalizedPaidRequestCount = Math.min(
                    totalRequestCount,
                    normalizeCounter(user.paidRequestCount)
                );
                if (normalizedPaidRequestCount !== user.paidRequestCount) {
                    user.paidRequestCount = normalizedPaidRequestCount;
                    changed = true;
                }

                const normalizedPaidEstimatedCost = Math.min(
                    totalEstimatedCost,
                    normalizeCost(user.paidEstimatedCost)
                );
                if (normalizedPaidEstimatedCost !== user.paidEstimatedCost) {
                    user.paidEstimatedCost = normalizedPaidEstimatedCost;
                    changed = true;
                }

                if (!isValidTimestamp(user.billingPeriodStartedAt)) {
                    user.billingPeriodStartedAt = isValidTimestamp(user.lastBillingSettlementAt)
                        ? user.lastBillingSettlementAt
                        : nowIso;
                    changed = true;
                }

                if (
                    typeof user.lastBillingSettlementAt !== 'undefined'
                    && !isValidTimestamp(user.lastBillingSettlementAt)
                ) {
                    user.lastBillingSettlementAt = user.billingPeriodStartedAt;
                    changed = true;
                }
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
                await writeFileAtomic(filePaths.models, JSON.stringify(modelsData, null, 2));
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

        const inFlight = this.inFlightLoads.get(dataType);
        if (inFlight) {
            return inFlight as Promise<T>;
        }

        const loadPromise = (async (): Promise<T> => {

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

                const cooldownUntil = this.redisReadCooldownUntil.get(dataType) || 0;
                if (cooldownUntil > Date.now()) {
                    return null;
                }

                try {
                    const redisTimeoutMs = dataType === 'keys' ? keysRedisReadTimeoutMs : redisReadTimeoutMs;
                    const redisData = await withTimeout(
                        this.redisClient!.hget(redisHashKey, redisField),
                        redisTimeoutMs,
                        `[DataManager] Redis HGET timed out for ${dataType}`
                    );
                    if (redisData) {
                        this.redisReadCooldownUntil.delete(dataType);
                        console.log(`[DataManager] Data loaded successfully from Redis for: ${dataType}`);
                        return JSON.parse(redisData) as T; 
                    }

                    const legacyData = await withTimeout(
                        this.redisClient!.get(legacyRedisKey),
                        redisTimeoutMs,
                        `[DataManager] Redis legacy GET timed out for ${dataType}`
                    );
                    if (legacyData) {
                        this.redisReadCooldownUntil.delete(dataType);
                        console.log(`[DataManager] Legacy Redis key found for ${dataType}; migrating to hash namespace.`);
                        await this.redisClient!.hset(redisHashKey, redisField, legacyData);
                        await this.redisClient!.del(legacyRedisKey);
                        return JSON.parse(legacyData) as T;
                    }

                     console.log(`[DataManager] No data found in Redis for: ${dataType}`);
                    return null; // Explicitly return null if key doesn't exist in Redis
                } catch (err) {
                    if (redisFailureCooldownMs > 0) {
                        this.redisReadCooldownUntil.set(dataType, Date.now() + redisFailureCooldownMs);
                    }
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
                     const fileData = await readTextFile(filePath);
                     console.log(`[DataManager] Data loaded successfully from Filesystem for: ${dataType}`);
                     return JSON.parse(fileData) as T;
                 } catch (err: any) {
                     if (err?.code === 'ENOENT') {
                         console.warn(`[DataManager] File not found: ${filePath}. Cannot load ${dataType} from filesystem.`);
                         return null;
                     }
                     if (dataType === 'keys') {
                         await backupInvalidKeysJson(filePath, err);
                         return null;
                     }
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
                    if (dataSourcePreference === 'redis' && !this.isRedisReady()) {
                        this.pendingRedisBackfill.add(dataType);
                    }
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
        })();

        this.inFlightLoads.set(dataType, loadPromise as Promise<ManagedDataStructure>);
        try {
            return await loadPromise;
        } finally {
            if (this.inFlightLoads.get(dataType) === loadPromise) {
                this.inFlightLoads.delete(dataType);
            }
        }
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
        const effectiveMaxRetries = dataType === 'providers' ? Math.max(maxRetries, 8) : maxRetries;

        if (this.isRedisReady()) {
            for (let attempt = 0; attempt < effectiveMaxRetries; attempt++) {
                const txClient = this.redisClient!.duplicate();
                let shouldRetry = false;
                try {
                    await txClient.watch(redisHashKey);
                    let currentRaw = await txClient.hget(redisHashKey, redisField);
                    if (!currentRaw) {
                        currentRaw = await txClient.get(legacyRedisKey);
                    }

                    let currentData = currentRaw
                        ? (JSON.parse(currentRaw) as T)
                        : this.cloneData(defaultEmptyData[dataType] as T);
                    if (dataType === 'keys') {
                        currentData = this.normalizeKeysSchema(currentData as KeysFile).normalized as T;
                    }
                    // `currentData` is already a fresh value parsed from Redis for this transaction,
                    // so avoid cloning the full dataset again on hot update paths (especially providers).
                    let updated = await updater(currentData);
                    if (dataType === 'keys') {
                        updated = this.normalizeKeysSchema(updated as KeysFile).normalized as T;
                    }

                    const tx = txClient.multi();
                    tx.hset(redisHashKey, redisField, JSON.stringify(updated));
                    tx.del(legacyRedisKey);
                    const execResult = await tx.exec();
                    if (execResult !== null) {
                        inMemoryCache[dataType] = { value: updated, ts: Date.now() };
                        // Mirror Redis updates back to filesystem to keep local JSON in sync.
                        void this.saveToFilesystemOnly(dataType, updated).catch((err) => {
                            console.warn(`[DataManager] Failed filesystem mirror after Redis update for ${dataType}:`, err);
                        });
                        return updated;
                    }
                    shouldRetry = true;
                } catch (err) {
                    shouldRetry = true;
                    if (attempt === effectiveMaxRetries - 1) {
                        console.warn(`[DataManager] Redis updateWithLock attempt ${attempt + 1} failed for ${dataType}:`, err);
                    }
                } finally {
                    try { await txClient.unwatch(); } catch { /* ignore */ }
                    try { await txClient.quit(); } catch { /* ignore */ }
                }

                if (shouldRetry && attempt < effectiveMaxRetries - 1) {
                    const baseBackoffMs = dataType === 'providers'
                        ? Math.min(20 * (2 ** attempt), 250)
                        : Math.min(10 * (attempt + 1), 50);
                    const jitterMs = dataType === 'providers' ? Math.floor(Math.random() * 25) : 0;
                    await sleepMs(baseBackoffMs + jitterMs);
                }
            }
            console.warn(`[DataManager] Falling back to filesystem update for ${dataType} after Redis contention.`);
        }

        const current = await this.load<T>(dataType);
        let updated = await updater(this.cloneData(current));
        if (dataType === 'keys') {
            updated = this.normalizeKeysSchema(updated as KeysFile).normalized as T;
        }
        await this.save<T>(dataType, updated);
        return updated;
    }

    private async saveToFilesystemOnly<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        // Safety guard: never overwrite providers.json with an empty array
        if (dataType === 'providers' && Array.isArray(data) && data.length === 0) {
            console.error('[DataManager] Refusing to save providers.json because data array is empty. Aborting save to prevent destruction.');
            return;
        }

        if (dataType === 'keys' && keysFilesystemSyncIntervalMs > 0) {
            const filePath = filePaths[dataType];
            let fileStringifiedData: string;
            try {
                if (data === null || typeof data !== 'object') throw new Error(`Invalid data type for ${dataType}: ${typeof data}`);
                fileStringifiedData = JSON.stringify(data, null, 2);
            } catch (err) {
                console.error(`[DataManager] Error stringifying data for ${dataType} (filesystem mirror). Aborting save. Error:`, err);
                return;
            }

            const pending = pendingFsWrites.get(dataType);
            if (pending?.timer) {
                // Keep the already-scheduled flush time so steady traffic cannot postpone writes forever.
                pending.data = fileStringifiedData;
                pending.filePath = filePath;
                return;
            }

            const pendingWrite = { timer: null as unknown as NodeJS.Timeout, data: fileStringifiedData, filePath };
            const timer = setTimeout(async () => {
                const latestPending = pendingFsWrites.get(dataType);
                if (!latestPending) return;
                try {
                    await writeFileAtomic(latestPending.filePath, latestPending.data);
                } catch (writeErr) {
                    console.error(`[DataManager] Failed writing ${dataType} to filesystem mirror (delayed):`, writeErr);
                } finally {
                    pendingFsWrites.delete(dataType);
                }
            }, keysFilesystemSyncIntervalMs);

            pendingWrite.timer = timer;
            pendingFsWrites.set(dataType, pendingWrite);
            return;
        }

        const filePath = filePaths[dataType];
        let fileStringifiedData: string;
        try {
            if (data === null || typeof data !== 'object') throw new Error(`Invalid data type for ${dataType}: ${typeof data}`);
            fileStringifiedData = JSON.stringify(data, null, 2);
        } catch (err) {
            console.error(`[DataManager] Error stringifying data for ${dataType} (filesystem mirror). Aborting save. Error:`, err);
            return;
        }

        try {
            await writeFileAtomic(filePath, fileStringifiedData);
        } catch (err) {
            console.error(`[DataManager] Failed writing ${dataType} to filesystem mirror:`, err);
        }
    }

    async save<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        // Safety guard: never overwrite providers.json with an empty array
        if (dataType === 'providers' && Array.isArray(data) && data.length === 0) {
            console.error('[DataManager] Refusing to save providers.json because data array is empty. Aborting save to prevent destruction.');
            return;
        }

        if (dataType === 'keys') {
            data = this.normalizeKeysSchema(data as KeysFile).normalized as T;
        }

        if (dataType === 'keys' && dataSourcePreference === 'redis') {
            await this.saveToRedisOnly(dataType, data);
            await this.saveToFilesystemOnly(dataType, data);
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
                await this.redisClient!.hset(redisHashKey, redisField, redisStringifiedData);
                await this.redisClient!.del(legacyRedisKey);
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
                if (dataType === 'keys' && keysFilesystemSyncIntervalMs > 0) {
                    await this.saveToFilesystemOnly(dataType, data);
                } else {
                    await writeFileAtomic(filePath, fileStringifiedData);
                }
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
export function isDataManagerReady(): boolean { return dataManager.isReady(); }
