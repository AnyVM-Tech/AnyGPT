import fs from 'fs';
import path from 'path';
import redis from './db'; 
import { Redis } from 'ioredis'; 

// --- Define or Import Data Structure Interfaces ---

// FIX: Add export
export interface LoadedProviderData { 
    id: string; 
    models: { [key: string]: any }; 
    provider_score: number | null; 
    apiKey?: string; // Keep optional fields if they exist
    provider_url?: string;
    category?: string; 
    avg_response_time?: number | null;
    avg_provider_latency?: number | null;
    errors?: number;
    // ... other provider fields
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
        
        if (this.isRedisReady()) {
            try {
                const redisData = await this.redisClient!.get(redisKey);
                if (redisData) {
                    const parsedData = JSON.parse(redisData);
                    console.log(`Data loaded from Redis for key: ${redisKey}`);
                    return parsedData as T; 
                }
            } catch (err) { console.error(`Error reading/parsing from Redis key ${redisKey}. Falling back:`, err); }
        } else { console.log(`Redis not ready, loading ${dataType} from filesystem.`); }

        try {
            if (fs.existsSync(filePath)) {
                const fileData = fs.readFileSync(filePath, 'utf8');
                const parsedData = JSON.parse(fileData);
                console.log(`Data loaded from filesystem: ${filePath}`);
                return parsedData as T;
            } else {
                 console.warn(`File not found: ${filePath}. Returning/creating default data for ${dataType}.`);
                 if (dataType === 'keys' || dataType === 'providers') {
                     await this.save(dataType, defaultValue); 
                 }
                return defaultValue;
            }
        } catch (err) { console.error(`Error reading/parsing file ${filePath}. Returning default:`, err); return defaultValue; }
    }

    async save<T extends ManagedDataStructure>(dataType: DataType, data: T): Promise<void> {
        if (dataType === 'models') { console.warn("Runtime save for models skipped."); return; }
        const redisKey = redisKeys[dataType];
        const filePath = filePaths[dataType];
        let stringifiedData: string;

        try {
             if (data === null || typeof data !== 'object') throw new Error(`Invalid data type for ${dataType}: ${typeof data}`);
            stringifiedData = JSON.stringify(data, null, 2);
        } catch (err) { console.error(`Error stringifying data for ${dataType}. Aborting:`, err); return; }

        let redisSuccess = false;
        if (this.isRedisReady()) {
            try {
                await this.redisClient!.set(redisKey, stringifiedData);
                redisSuccess = true; console.log(`Data saved to Redis: ${redisKey}`);
            } catch (err) { console.error(`Error writing to Redis key ${redisKey}. FS save still attempted:`, err); }
        } else { console.log(`Redis not ready. Saving ${dataType} to filesystem.`); }

        try {
            await fs.promises.writeFile(filePath, stringifiedData, 'utf8');
            console.log(`Data saved to filesystem: ${filePath}`);
        } catch (err) {
            console.error(`CRITICAL: Error writing file ${filePath}:`, err);
            if (!redisSuccess) console.error(`!!! Data loss possible: Failed save for ${dataType} to Redis & FS.`);
        }
    }
}

export const dataManager = new DataManager(redis); 
export function isDataManagerReady(): boolean { return true; }
