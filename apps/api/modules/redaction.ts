import crypto from 'crypto';

const DEFAULT_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'anygpt-api';

if (!process.env.API_KEY_HASH_SECRET) {
  console.warn(
    '[Security] API_KEY_HASH_SECRET is not set. Using default static secret for key hashing. ' +
    'Set API_KEY_HASH_SECRET in your .env to a random value for production use.'
  );
}

export function redactToken(value?: string | null, visiblePrefix = 4, visibleSuffix = 4): string | null {
  if (!value) return null;
  const token = String(value);
  if (token.length <= visiblePrefix + visibleSuffix) {
    return '*'.repeat(Math.max(token.length, 4));
  }
  return `${token.slice(0, visiblePrefix)}...${token.slice(-visibleSuffix)}`;
}

export function redactAuthorizationHeader(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^Bearer\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^Bearer\s+/i, '');
    return `Bearer ${redactToken(token)}`;
  }
  return redactToken(trimmed);
}

// Derive a stable, hard-to-brute-force identifier for an API key using PBKDF2.
// NOTE: Changing these parameters will change the resulting hashes.
const HASH_TOKEN_ITERATIONS = (() => {
  const raw = Number(process.env.API_KEY_HASH_ITERATIONS);
  if (Number.isFinite(raw) && raw >= 1000) return Math.floor(raw);
  return 20_000;
})();
const HASH_TOKEN_KEYLEN = (() => {
  const raw = Number(process.env.API_KEY_HASH_KEYLEN);
  if (Number.isFinite(raw) && raw >= 16) return Math.floor(raw);
  return 32;
})();
const HASH_TOKEN_DIGEST = 'sha256';
const HASH_TOKEN_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.API_KEY_HASH_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 5 * 60 * 1000;
})();
const HASH_TOKEN_CACHE_MAX = (() => {
  const raw = Number(process.env.API_KEY_HASH_CACHE_MAX);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 10_000;
})();

type HashCacheEntry = { value: string; expiresAt: number };
const tokenHashCache = new Map<string, HashCacheEntry>();

function getCachedTokenHash(cacheKey: string): string | null {
  if (HASH_TOKEN_CACHE_MAX <= 0 || HASH_TOKEN_CACHE_TTL_MS <= 0) return null;
  const entry = tokenHashCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokenHashCache.delete(cacheKey);
    return null;
  }
  tokenHashCache.delete(cacheKey);
  tokenHashCache.set(cacheKey, entry);
  return entry.value;
}

function setCachedTokenHash(cacheKey: string, value: string): void {
  if (HASH_TOKEN_CACHE_MAX <= 0 || HASH_TOKEN_CACHE_TTL_MS <= 0) return;
  if (tokenHashCache.size >= HASH_TOKEN_CACHE_MAX) {
    const oldestKey = tokenHashCache.keys().next().value;
    if (oldestKey) tokenHashCache.delete(oldestKey);
  }
  tokenHashCache.set(cacheKey, { value, expiresAt: Date.now() + HASH_TOKEN_CACHE_TTL_MS });
}

function deriveTokenHash(value: string, secret: string): string {
  const derived = crypto.pbkdf2Sync(
    value,
    secret,
    HASH_TOKEN_ITERATIONS,
    HASH_TOKEN_KEYLEN,
    HASH_TOKEN_DIGEST
  );
  return derived.toString('hex');
}

export function hashToken(value: string, secret: string = DEFAULT_HASH_SECRET): string {
  const cacheKey = `${secret}:${value}`;
  const cached = getCachedTokenHash(cacheKey);
  if (cached) return cached;
  const derived = deriveTokenHash(value, secret);
  setCachedTokenHash(cacheKey, derived);
  return derived;
}
