import fs from 'node:fs';
import path from 'node:path';
import defaultTiersData from '../tiers.json' with { type: 'json' };
import redis from './db.js';

type PublicMetadataValue = string | number | boolean | null;

export interface TierSupport {
  channel?: string | null;
  contact?: string | null;
  response_target?: string | null;
  notes?: string | null;
  url?: string | null;
}

export interface TierData {
  rps: number | null;
  rpm: number | null;
  rpd: number | null;
  display_name?: string | null;
  description?: string | null;
  features?: string[] | null;
  support?: TierSupport | null;
  allowed_models?: string[] | null;
  blocked_models?: string[] | null;
  public_metadata?: Record<string, PublicMetadataValue> | null;
  soft_rpd?: number | null;
  billing_period_request_target?: number | null;
  max_tokens: number | null;
  min_provider_score: number | null;
  max_provider_score: number | null;
}

export type TiersFile = Record<string, TierData>;

const tiersFilePath = path.resolve(process.env.API_TIERS_FILE || 'tiers.json');
const tiersReloadCheckMs = Math.max(
  0,
  Number(process.env.TIERS_RELOAD_CHECK_MS ?? (process.env.NODE_ENV === 'test' ? '0' : '1000')) || 0
);
const tiersRedisHashKey = 'api:data';
const tiersRedisField = 't';
const tiersRedisLegacyKey = 'api:tiers_data';
const tiersDataSourcePreference: 'redis' | 'filesystem' =
  process.env.DATA_SOURCE_PREFERENCE === 'filesystem' ? 'filesystem' : 'redis';

let lastReloadCheckAt = 0;
let lastKnownFileSignature = '';
let lastLoggedLoadFailureSignature = '';

function cloneTiers<T extends TiersFile>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildFileSignature(stat: fs.Stats | null): string {
  if (!stat) return 'missing';
  return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

function readOptionalTrimmedString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('expected a string or null');
  return value.trim();
}

function readNullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer or null.`);
  }
  return Math.floor(parsed);
}

function readRequiredNullableNonNegativeInteger(
  source: Record<string, unknown>,
  field: keyof TierData & string
): number | null {
  if (!(field in source)) {
    throw new Error(`${field} is required.`);
  }
  return readNullableNonNegativeInteger(source[field], field);
}

function normalizeStringArray(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings or null.`);
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${field} must contain only strings.`);
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeSupport(value: unknown): TierSupport | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('support must be an object or null.');
  }

  const source = value as Record<string, unknown>;
  const support: TierSupport = {};

  if ('channel' in source) support.channel = readOptionalTrimmedString(source.channel);
  if ('contact' in source) support.contact = readOptionalTrimmedString(source.contact);
  if ('response_target' in source) support.response_target = readOptionalTrimmedString(source.response_target);
  if ('notes' in source) support.notes = readOptionalTrimmedString(source.notes);
  if ('url' in source) support.url = readOptionalTrimmedString(source.url);

  return support;
}

function normalizePublicMetadata(value: unknown): Record<string, PublicMetadataValue> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('public_metadata must be an object or null.');
  }

  const normalized: Record<string, PublicMetadataValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    if (
      entry === null
      || typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
    ) {
      normalized[normalizedKey] = entry;
      continue;
    }
    throw new Error(`public_metadata.${normalizedKey} must be a string, number, boolean, or null.`);
  }
  return normalized;
}

function assertTierRelationships(tierId: string, tier: TierData): void {
  if (
    typeof tier.soft_rpd === 'number'
    && typeof tier.rpd === 'number'
    && tier.soft_rpd > tier.rpd
  ) {
    throw new Error(`Tier '${tierId}' has soft_rpd greater than rpd.`);
  }

  if (
    typeof tier.min_provider_score === 'number'
    && typeof tier.max_provider_score === 'number'
    && tier.min_provider_score > tier.max_provider_score
  ) {
    throw new Error(`Tier '${tierId}' has min_provider_score greater than max_provider_score.`);
  }
}

export function normalizeTierData(value: unknown, tierId: string = 'tier'): TierData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Tier '${tierId}' must be an object.`);
  }

  const source = value as Record<string, unknown>;
  const normalized = {
    ...source,
    rps: readRequiredNullableNonNegativeInteger(source, 'rps'),
    rpm: readRequiredNullableNonNegativeInteger(source, 'rpm'),
    rpd: readRequiredNullableNonNegativeInteger(source, 'rpd'),
    max_tokens: readRequiredNullableNonNegativeInteger(source, 'max_tokens'),
    min_provider_score: readRequiredNullableNonNegativeInteger(source, 'min_provider_score'),
    max_provider_score: readRequiredNullableNonNegativeInteger(source, 'max_provider_score'),
  } as TierData;

  if ('display_name' in source) normalized.display_name = readOptionalTrimmedString(source.display_name);
  if ('description' in source) normalized.description = readOptionalTrimmedString(source.description);
  if ('features' in source) normalized.features = normalizeStringArray(source.features, 'features');
  if ('support' in source) normalized.support = normalizeSupport(source.support);
  if ('allowed_models' in source) normalized.allowed_models = normalizeStringArray(source.allowed_models, 'allowed_models');
  if ('blocked_models' in source) normalized.blocked_models = normalizeStringArray(source.blocked_models, 'blocked_models');
  if ('public_metadata' in source) normalized.public_metadata = normalizePublicMetadata(source.public_metadata);
  if ('soft_rpd' in source) normalized.soft_rpd = readNullableNonNegativeInteger(source.soft_rpd, 'soft_rpd');
  if ('billing_period_request_target' in source) {
    normalized.billing_period_request_target = readNullableNonNegativeInteger(
      source.billing_period_request_target,
      'billing_period_request_target'
    );
  }

  assertTierRelationships(tierId, normalized);
  return normalized;
}

export function normalizeTiersFile(value: unknown): TiersFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tiers.json must contain an object keyed by tier id.');
  }

  const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([rawTierId, tierValue]) => {
    const tierId = rawTierId.trim();
    if (!tierId) {
      throw new Error('tiers.json contains an empty tier id.');
    }
    return [tierId, normalizeTierData(tierValue, tierId)] as const;
  });

  normalizedEntries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(normalizedEntries);
}

function loadInitialTiersSync(): TiersFile {
  try {
    const raw = fs.readFileSync(tiersFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeTiersFile(parsed);
    try {
      const stat = fs.statSync(tiersFilePath);
      lastKnownFileSignature = buildFileSignature(stat);
    } catch {
      lastKnownFileSignature = '';
    }
    return normalized;
  } catch (error) {
    console.warn(`[TierManager] Falling back to bundled tiers data for ${tiersFilePath}.`, error);
    return normalizeTiersFile(defaultTiersData);
  }
}

let cachedTiers: TiersFile = loadInitialTiersSync();

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, contents, 'utf8');
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (error: any) {
    if (error?.code === 'EXDEV') {
      await fs.promises.copyFile(tmpPath, filePath);
      await fs.promises.unlink(tmpPath);
      return;
    }
    throw error;
  }
}

function normalizeAndClone(value: unknown): TiersFile {
  return cloneTiers(normalizeTiersFile(value));
}

async function readTiersFromFilesystem(): Promise<TiersFile | null> {
  try {
    const raw = await fs.promises.readFile(tiersFilePath, 'utf8');
    const normalized = normalizeAndClone(JSON.parse(raw));
    try {
      const stat = await fs.promises.stat(tiersFilePath);
      lastKnownFileSignature = buildFileSignature(stat);
    } catch {
      lastKnownFileSignature = '';
    }
    lastLoggedLoadFailureSignature = '';
    return normalized;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    let signature = 'unknown';
    try {
      const stat = await fs.promises.stat(tiersFilePath);
      signature = buildFileSignature(stat);
    } catch {
      signature = 'unknown';
    }
    if (signature !== lastLoggedLoadFailureSignature) {
      console.warn(`[TierManager] Failed to load ${tiersFilePath}; continuing with cached tiers.`, error);
      lastLoggedLoadFailureSignature = signature;
    }
    return null;
  }
}

async function readTiersFromRedis(): Promise<TiersFile | null> {
  if (!redis || redis.status !== 'ready') return null;
  try {
    const redisRaw =
      await redis.hget(tiersRedisHashKey, tiersRedisField)
      || await redis.get(tiersRedisLegacyKey);
    if (!redisRaw) return null;
    return normalizeAndClone(JSON.parse(redisRaw));
  } catch (error) {
    console.warn('[TierManager] Failed reading tiers from Redis; falling back to filesystem cache.', error);
    return null;
  }
}

async function saveTiersToFilesystem(tiers: TiersFile): Promise<boolean> {
  const contents = `${JSON.stringify(tiers, null, 2)}\n`;
  try {
    await writeFileAtomic(tiersFilePath, contents);
    try {
      const stat = await fs.promises.stat(tiersFilePath);
      lastKnownFileSignature = buildFileSignature(stat);
    } catch {
      lastKnownFileSignature = '';
    }
    lastLoggedLoadFailureSignature = '';
    return true;
  } catch (error) {
    console.error(`[TierManager] Failed saving ${tiersFilePath}.`, error);
    return false;
  }
}

async function saveTiersToRedis(tiers: TiersFile): Promise<boolean> {
  if (!redis || redis.status !== 'ready') return false;
  try {
    const raw = JSON.stringify(tiers);
    await redis.hset(tiersRedisHashKey, tiersRedisField, raw);
    await redis.del(tiersRedisLegacyKey);
    return true;
  } catch (error) {
    console.error('[TierManager] Failed saving tiers to Redis.', error);
    return false;
  }
}

export function getTiersFilePath(): string {
  return tiersFilePath;
}

export function getCachedTiers(): TiersFile {
  return cloneTiers(cachedTiers);
}

export async function loadTiers(options: { force?: boolean } = {}): Promise<TiersFile> {
  const now = Date.now();
  if (
    !options.force
    && tiersReloadCheckMs > 0
    && now - lastReloadCheckAt < tiersReloadCheckMs
  ) {
    return cloneTiers(cachedTiers);
  }

  lastReloadCheckAt = now;

  let loaded: TiersFile | null = null;
  let loadedSource: 'redis' | 'filesystem' | null = null;

  if (tiersDataSourcePreference === 'redis') {
    loaded = await readTiersFromRedis();
    if (loaded) loadedSource = 'redis';
    if (!loaded) {
      loaded = await readTiersFromFilesystem();
      if (loaded) loadedSource = 'filesystem';
      if (loaded && redis && redis.status === 'ready') {
        void saveTiersToRedis(loaded);
      }
    }
  } else {
    loaded = await readTiersFromFilesystem();
    if (loaded) loadedSource = 'filesystem';
    if (!loaded) {
      loaded = await readTiersFromRedis();
      if (loaded) loadedSource = 'redis';
      if (loaded) {
        void saveTiersToFilesystem(loaded);
      }
    }
  }

  if (loaded) {
    cachedTiers = loaded;
    return cloneTiers(cachedTiers);
  }

  if (options.force) {
    console.warn(
      `[TierManager] Unable to reload tiers from ${loadedSource ?? 'configured sources'}; using last known good cached tiers.`
    );
  }
  return cloneTiers(cachedTiers);
}

export async function saveTiers(nextTiers: TiersFile): Promise<TiersFile> {
  const normalized = normalizeTiersFile(nextTiers);
  const [redisSaved, fileSaved] = await Promise.all([
    saveTiersToRedis(normalized),
    saveTiersToFilesystem(normalized),
  ]);

  if (!redisSaved && !fileSaved) {
    throw new Error('Failed to persist tiers to both Redis and filesystem.');
  }

  cachedTiers = normalized;
  lastReloadCheckAt = Date.now();
  lastLoggedLoadFailureSignature = '';
  return cloneTiers(cachedTiers);
}

export async function syncTiersBetweenRedisAndFilesystem(): Promise<TiersFile> {
  const [filesystemTiers, redisTiers] = await Promise.all([
    readTiersFromFilesystem(),
    readTiersFromRedis(),
  ]);

  const fallbackDefault = normalizeAndClone(defaultTiersData);
  const preferred = tiersDataSourcePreference === 'redis'
    ? (redisTiers || filesystemTiers || fallbackDefault)
    : (filesystemTiers || redisTiers || fallbackDefault);

  return await saveTiers(preferred);
}

export function mergeTierPatch(currentTier: TierData, patchValue: unknown, tierId: string): TierData {
  if (!patchValue || typeof patchValue !== 'object' || Array.isArray(patchValue)) {
    throw new Error(`Tier patch for '${tierId}' must be an object.`);
  }

  const patch = patchValue as Record<string, unknown>;
  const mergedSupport = Object.prototype.hasOwnProperty.call(patch, 'support')
    && patch.support
    && typeof patch.support === 'object'
    && !Array.isArray(patch.support)
    ? {
        ...(currentTier.support && typeof currentTier.support === 'object' ? currentTier.support : {}),
        ...(patch.support as Record<string, unknown>),
      }
    : patch.support;

  const merged: TierData = {
    ...currentTier,
    ...patch,
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'support')) {
    merged.support = mergedSupport as TierSupport | null | undefined;
  }

  return normalizeTierData(merged, tierId);
}

export async function getTier(tierId: string): Promise<TierData | null> {
  const tiers = await loadTiers();
  return tiers[tierId] ? { ...tiers[tierId] } : null;
}

export function getFallbackUserTierId(tiers: TiersFile = cachedTiers): string | null {
  if (tiers.free) return 'free';
  const tierIds = Object.keys(tiers);
  return tierIds.length > 0 ? tierIds[0] : null;
}

export function getDefaultAdminTierId(tiers: TiersFile = cachedTiers): string | null {
  if (tiers.enterprise) return 'enterprise';
  return getFallbackUserTierId(tiers);
}
