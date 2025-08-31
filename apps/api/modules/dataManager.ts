import fs from 'fs';
import path from 'path';
import redis from './db.js'; 
import { Redis } from 'ioredis'; 
import { refreshProviderCountsInModelsFile } from './modelUpdater.js'; // Import the refresh function

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
const redisKeys: Record<DataType, string> = {
    providers: 'api:providers_data',
    keys: 'api:keys_data',
    models: 'api:models_data', 
};
const defaultEmptyData: Record<DataType, any> = {
    providers: [],
    keys: {},
    models: { object: 'list', data: [] },
};

// Set to track if filesystem fallback has been logged for a dataType
const filesystemFallbackLogged = new Set<DataType>();

// Get data source preference
const dataSourcePreference: 'redis' | 'filesystem' = process.env.DATA_SOURCE_PREFERENCE === 'redis' ? 'redis' : 'filesystem';
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

     public readFile(filePath: string, encoding: BufferEncoding = 'utf8'): string {
         try {
            if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
            return fs.readFileSync(filePath, encoding);
         } catch(err) {
             console.error(`Error reading file ${filePath}:`, err); throw err; 
         }
     }

    async load<T extends ManagedDataStructure>(dataType: DataType): Promise<T> {
        const redisKey = redisKeys[dataType];
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
                const redisData = await this.redisClient!.get(redisKey);
                if (redisData) {
                    console.log(`[DataManager] Data loaded successfully from Redis for: ${dataType}`);
                    return JSON.parse(redisData) as T; 
                }
                 console.log(`[DataManager] No data found in Redis for: ${dataType}`);
                return null; // Explicitly return null if key doesn't exist in Redis
            } catch (err) {
                 console.error(`[DataManager] Error loading/parsing from Redis key ${redisKey}. Error:`, err);
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

        // Attempt to load based on preference
        if (dataSourcePreference === 'redis') {
            loadedData = await loadFromRedis();
            if (loadedData === null) { // If Redis failed or was empty, try filesystem
                console.log(`[DataManager] Redis preferred, but failed/empty for ${dataType}. Trying filesystem.`);
                loadedData = await loadFromFilesystem();
                if (loadedData !== null) {
                    loadedFromFallback = true; // Mark that data was loaded from fallback
                }
            }
        } else { // Filesystem preference
            loadedData = await loadFromFilesystem();
            if (loadedData === null) { // If filesystem failed or was empty, try Redis
                console.log(`[DataManager] Filesystem preferred, but failed/empty for ${dataType}. Trying Redis.`);
                loadedData = await loadFromRedis();
                if (loadedData !== null) {
                    loadedFromFallback = true; // Mark that data was loaded from fallback
                }
            }
        }

        // If data loaded successfully from either source
        if (loadedData !== null) {
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
        return defaultValue;
    }

    async save<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        const redisKey = redisKeys[dataType];
        const filePath = filePaths[dataType];
        let stringifiedData: string;

        try {
             if (data === null || typeof data !== 'object') throw new Error(`Invalid data type for ${dataType}: ${typeof data}`);
            stringifiedData = JSON.stringify(data, null, 2);
        } catch (err) { 
            console.error(`[DataManager] Error stringifying data for ${dataType}. Aborting save. Error:`, err);
            // Optionally log to error logger
            // await logError({ message: `Data serialization failed for ${dataType}`, error: err }); 
            return; 
        }

        let redisSuccess = false;
        let fsSuccess = false;

        // Attempt Redis Save
        if (this.isRedisReady()) {
            try {
                await this.redisClient!.set(redisKey, stringifiedData);
                redisSuccess = true; 
                console.log(`[DataManager] Data saved successfully to Redis for: ${dataType}`);
            } catch (err) {
                 console.error(`[DataManager] Error saving to Redis key ${redisKey}. Error:`, err);
                 if (dataSourcePreference === 'redis') {
                     console.error(`[DataManager] CRITICAL: Failed to save to preferred source (Redis) for ${dataType}.`);
                 }
            }
        } else {
             if (!filesystemFallbackLogged.has(dataType)) {
                 console.log(`DataManager: Redis not ready. Cannot save ${dataType} to Redis.`);
                 // No need to add to set here, filesystem log will handle it if that's the preference
            }
             if (dataSourcePreference === 'redis') {
                 console.error(`[DataManager] CRITICAL: Cannot save to preferred source (Redis) for ${dataType} - Client not ready.`);
             }
        }

        // Attempt Filesystem Save
        try {
            await fs.promises.writeFile(filePath, stringifiedData, 'utf8');
            fsSuccess = true;
            console.log(`[DataManager] Data saved successfully to Filesystem for: ${dataType}`);
        } catch (err) {
            console.error(`[DataManager] Error saving to file ${filePath}. Error:`, err);
            if (dataSourcePreference === 'filesystem') {
                 console.error(`[DataManager] CRITICAL: Failed to save to preferred source (Filesystem) for ${dataType}.`);
            }
        }

        // Final status log
        if (!redisSuccess && !fsSuccess) {
            console.error(`[DataManager] !!! Data Save FAILED for ${dataType} on BOTH Redis and Filesystem !!!`);
        } else if (!redisSuccess && dataSourcePreference === 'redis') {
            console.warn(`[DataManager] WARNING: Saved ${dataType} to Filesystem, but FAILED to save to preferred source (Redis).`);
        } else if (!fsSuccess && dataSourcePreference === 'filesystem') {
             console.warn(`[DataManager] WARNING: Saved ${dataType} to Redis, but FAILED to save to preferred source (Filesystem).`);
        }

        // Trigger model count refresh if providers data changed, regardless of save success details
        // (as long as the intent was to save new provider data)
        if (dataType === 'providers') {
            console.log('[DataManager] Provider data save attempted, scheduling refresh of model provider counts.');
            Promise.resolve().then(refreshProviderCountsInModelsFile).catch(err => {
                console.error('Error during scheduled refreshProviderCountsInModelsFile:', err);
            });
        }
    }
}

export const dataManager = new DataManager(redis); 
export function isDataManagerReady(): boolean { return true; }
