import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import redis from './db.js';
import { dataManager, LoadedProviders, LoadedProviderData } from './dataManager.js';
import { checkKey, type KeyStatus } from './keyChecker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, '..', '..');
}

const BASE_DIR = findProjectRoot(__dirname);

const ADMIN_KEYS_PATH = path.resolve(BASE_DIR, 'logs', 'admin-keys.jsonl');
const TSX_PATH = path.resolve(BASE_DIR, 'node_modules', '.bin', 'tsx');
const NODE_PATH = process.execPath;
const RUNNER = String(process.env.ADMIN_KEY_SYNC_RUNNER || 'tsgo').toLowerCase();
const LOCK_KEY = 'admin-key-sync:lock';
const LOCK_FILE = path.join(os.tmpdir(), 'anygpt-admin-key-sync.lock');
const PROBE_TESTED_PATH = path.resolve(BASE_DIR, 'logs', 'probe-tested.json');

const SYNC_ENABLED = process.env.ADMIN_KEY_SYNC_ENABLED !== '0';
const RUN_TRANSFER = process.env.ADMIN_KEY_SYNC_RUN_TRANSFER !== '0';
const RUN_PROBES = process.env.ADMIN_KEY_SYNC_RUN_PROBES !== '0';
const DEBOUNCE_MS = Math.max(0, Number(process.env.ADMIN_KEY_SYNC_DEBOUNCE_MS ?? 5000));
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.ADMIN_KEY_SYNC_MIN_INTERVAL_MS ?? 5 * 60 * 1000));
const INTERVAL_MS = Math.max(0, Number(process.env.ADMIN_KEY_SYNC_INTERVAL_MS ?? 30 * 60 * 1000));
const LOCK_TTL_MS = Math.max(10_000, Number(process.env.ADMIN_KEY_SYNC_LOCK_TTL_MS ?? 10 * 60 * 1000));
const STARTUP_PROBE_COOLDOWN_MS = Math.max(0, Number(process.env.ADMIN_KEY_SYNC_STARTUP_PROBE_COOLDOWN_MS ?? 60 * 60 * 1000));
const PROBE_MAX_MODELS = process.env.ADMIN_KEY_SYNC_PROBE_MAX_MODELS;
const PROBE_ALL_CAPS = process.env.ADMIN_KEY_SYNC_PROBE_ALL_CAPS;
const CHECK_DISABLED_KEYS = process.env.ADMIN_KEY_SYNC_CHECK_DISABLED !== '0';
const DISABLED_KEY_CHECK_CONCURRENCY = Math.max(1, Number(process.env.ADMIN_KEY_SYNC_DISABLED_CONCURRENCY ?? 4));

let running = false;
let pending = false;
let scheduled: NodeJS.Timeout | null = null;
let lastRunAt = 0;
let lastAdminKeySignature = '';
let lockToken: string | null = null;
let lockType: 'redis' | 'file' | null = null;

function getAdminKeysSignature(): string {
  try {
    const stat = fs.statSync(ADMIN_KEYS_PATH);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

function getLastProbeTimestamp(): number {
  try {
    const raw = fs.readFileSync(PROBE_TESTED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const updatedAt = typeof parsed?.updated_at === 'string' ? Date.parse(parsed.updated_at) : NaN;
    if (Number.isFinite(updatedAt)) return updatedAt;
    const stat = fs.statSync(PROBE_TESTED_PATH);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  } catch {
    try {
      const stat = fs.statSync(PROBE_TESTED_PATH);
      return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      return 0;
    }
  }
}

async function acquireRedisLock(): Promise<boolean> {
  if (!redis || redis.status !== 'ready') return false;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const res = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (res === 'OK') {
    lockToken = token;
    lockType = 'redis';
    return true;
  }
  return false;
}

async function releaseRedisLock(): Promise<void> {
  if (!redis || !lockToken) return;
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redis.eval(lua, 1, LOCK_KEY, lockToken);
  } catch (err) {
    console.warn('[AdminKeySync] Failed releasing redis lock:', err);
  }
}

function acquireFileLock(): boolean {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ token, ts: Date.now() }), 'utf8');
    fs.closeSync(fd);
    lockToken = token;
    lockType = 'file';
    return true;
  } catch {
    try {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const ts = Number(parsed?.ts || 0);
      if (ts && Date.now() - ts > LOCK_TTL_MS) {
        fs.unlinkSync(LOCK_FILE);
        return acquireFileLock();
      }
    } catch {
      // Ignore
    }
    return false;
  }
}

function releaseFileLock(): void {
  if (!lockToken) return;
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.token === lockToken) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore
  }
}

async function acquireLock(): Promise<boolean> {
  if (await acquireRedisLock()) return true;
  return acquireFileLock();
}

async function releaseLock(): Promise<void> {
  if (lockType === 'redis') await releaseRedisLock();
  if (lockType === 'file') releaseFileLock();
  lockToken = null;
  lockType = null;
}

function resolveScriptTarget(script: string): { cmd: string; args: string[] } {
  const tsPath = path.resolve(BASE_DIR, script);
  const distPath = path.resolve(BASE_DIR, 'dist', script.replace(/\.ts$/, '.js'));

  if ((RUNNER === 'tsgo' || RUNNER === 'node') && fs.existsSync(distPath)) {
    return { cmd: NODE_PATH, args: [distPath] };
  }

  if (RUNNER === 'tsgo') {
    throw new Error(`[AdminKeySync] Runner=tsgo requires compiled script at ${distPath}. Run build first.`);
  }

  return { cmd: TSX_PATH, args: [tsPath] };
}

function runScript(label: string, script: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = resolveScriptTarget(script);
    const child = spawn(target.cmd, target.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${label} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function getProviderFamily(providerId: string): string {
  const lower = String(providerId || '').toLowerCase();
  if (lower.includes('openai')) return 'openai';
  if (lower.includes('gemini') || lower === 'google') return 'gemini';
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('openrouter')) return 'openrouter';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('xai') || lower.includes('x-ai')) return 'xai';
  return '';
}

/**
 * Lightweight health check for disabled provider keys.
 * Uses keyChecker to validate the key works and has quota, then re-enables
 * providers whose keys are now healthy. Does NOT test full model capabilities.
 */
async function checkDisabledProviderKeys(): Promise<void> {
  try {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const disabled = providers.filter((p: LoadedProviderData) => p.disabled && p.apiKey);
    if (disabled.length === 0) return;

    console.log(`[AdminKeySync] Checking ${disabled.length} disabled provider key(s)...`);
    let reEnabled = 0;
    let stillDisabled = 0;

    // Process in batches to limit concurrency
    for (let i = 0; i < disabled.length; i += DISABLED_KEY_CHECK_CONCURRENCY) {
      const batch = disabled.slice(i, i + DISABLED_KEY_CHECK_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (provider: LoadedProviderData) => {
          const family = getProviderFamily(provider.id);
          if (!family) return { provider, status: null as KeyStatus | null };
          const status = await checkKey(family, provider.apiKey!);
          return { provider, status };
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value.status) continue;
        const { provider, status } = result.value;
        if (!status) continue;

        if (status.isValid && status.hasQuota !== false) {
          // Key is valid and has quota — re-enable the provider
          const idx = providers.findIndex((p: LoadedProviderData) => p.id === provider.id);
          if (idx !== -1) {
            providers[idx].disabled = false;
            // Also re-enable all models that were disabled due to consecutive errors
            for (const modelId of Object.keys(providers[idx].models || {})) {
              const model = providers[idx].models[modelId] as any;
              if (model?.disabled) {
                model.disabled = false;
                model.consecutive_errors = 0;
                model.disable_count = 0;
                model.disabled_at = undefined;
              }
            }
            reEnabled++;
            console.log(`[AdminKeySync] Re-enabled provider ${provider.id} — key is valid with quota.`);
          }
        } else {
          stillDisabled++;
          const reason = !status.isValid ? 'invalid key' : 'no quota';
          console.log(`[AdminKeySync] Provider ${provider.id} stays disabled (${reason}).`);
        }
      }
    }

    if (reEnabled > 0) {
      await dataManager.save<LoadedProviders>('providers', providers);
      console.log(`[AdminKeySync] Disabled key check complete. Re-enabled: ${reEnabled}, still disabled: ${stillDisabled}.`);
    } else {
      console.log(`[AdminKeySync] Disabled key check complete. No providers re-enabled (${stillDisabled} still disabled).`);
    }
  } catch (err) {
    console.warn('[AdminKeySync] Disabled key check failed:', err);
  }
}

async function runSync(reason: string, force = false): Promise<void> {
  if (!SYNC_ENABLED) return;
  if (running) {
    pending = true;
    return;
  }
  const now = Date.now();
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) {
    schedule(reason, force, MIN_INTERVAL_MS - (now - lastRunAt));
    return;
  }

  running = true;
  pending = false;

  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    running = false;
    return;
  }

  try {
    const signature = getAdminKeysSignature();
    if (!force && signature && signature === lastAdminKeySignature) {
      lastRunAt = Date.now();
      return;
    }

    lastAdminKeySignature = signature;
    if (RUN_TRANSFER) {
      await runScript('transferAdminKeys', 'dev/transferAdminKeys.ts');
    }

    let skipProbes = false;
    if (reason === 'startup' && STARTUP_PROBE_COOLDOWN_MS > 0) {
      const lastProbeAt = getLastProbeTimestamp();
      if (lastProbeAt > 0 && (Date.now() - lastProbeAt) < STARTUP_PROBE_COOLDOWN_MS) {
        skipProbes = true;
        console.log('[AdminKeySync] Skipping startup probes (recent run detected).');
      }
    }

    if (RUN_PROBES && !skipProbes) {
      const probeEnv: Record<string, string> = {};
      if (PROBE_MAX_MODELS) probeEnv.CAP_TEST_MAX_MODELS = PROBE_MAX_MODELS;
      if (PROBE_ALL_CAPS) probeEnv.CAP_TEST_ALL_CAPS = PROBE_ALL_CAPS;
      await runScript('testModelLiveProbes', 'dev/testModelLiveProbes.ts', probeEnv);
    }

    // Lightweight key health check for disabled providers
    if (CHECK_DISABLED_KEYS) {
      await checkDisabledProviderKeys();
    }

    lastRunAt = Date.now();
  } catch (err) {
    console.warn(`[AdminKeySync] Sync run failed (${reason}):`, err);
  } finally {
    await releaseLock();
    running = false;
    if (pending) {
      pending = false;
      schedule('pending', true);
    }
  }
}

function schedule(reason: string, force = false, delayOverride?: number): void {
  if (!SYNC_ENABLED) return;
  if (scheduled) clearTimeout(scheduled);
  const delay = typeof delayOverride === 'number' ? delayOverride : DEBOUNCE_MS;
  scheduled = setTimeout(() => {
    scheduled = null;
    runSync(reason, force).catch((err) => console.warn('[AdminKeySync] Scheduled run failed:', err));
  }, delay);
}

export function notifyAdminKeyReceived(): void {
  schedule('admin-key', true);
}

/**
 * Called when new models without capabilities are discovered during model sync.
 * Triggers a probe run so the new models get their capabilities tested.
 */
export function notifyNewModelsDiscovered(modelIds: string[]): void {
  if (!SYNC_ENABLED || !RUN_PROBES) return;
  if (modelIds.length === 0) return;
  console.log(`[AdminKeySync] New models without capabilities detected: ${modelIds.join(', ')}. Scheduling probe run.`);
  schedule('new-models', true);
}

export function startAdminKeySyncScheduler(): void {
  if (!SYNC_ENABLED) return;
  if (INTERVAL_MS > 0) {
    setInterval(() => schedule('interval', true), INTERVAL_MS);
  }
  schedule('startup', false);
}
