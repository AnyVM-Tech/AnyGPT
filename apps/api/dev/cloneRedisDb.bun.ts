import dotenv from 'dotenv';
import path from 'node:path';
import { createClient } from '../../langgraph-control-plane/node_modules/redis';

function log(message: string): void {
  console.log(`[experimental-redis-clone] ${message}`);
}

function buildRedisConnectionString(db: string): string {
  const redisUrlFromEnv = process.env.REDIS_URL;
  const redisUser = process.env.REDIS_USERNAME;
  const redisPass = process.env.REDIS_PASSWORD;
  const useTls = process.env.REDIS_TLS === 'true';
  const protocol = useTls ? 'rediss' : 'redis';

  if (!redisUrlFromEnv) {
    throw new Error('REDIS_URL is required to clone the experimental Redis store.');
  }

  if (redisUrlFromEnv.includes('://')) {
    const url = new URL(redisUrlFromEnv);
    if (redisUser) url.username = redisUser;
    if (redisPass) url.password = redisPass;
    url.pathname = `/${db}`;
    url.protocol = `${protocol}:`;
    return url.toString();
  }

  const [host, port] = redisUrlFromEnv.split(':');
  if (!host || !port) {
    throw new Error(`Invalid REDIS_URL format: ${redisUrlFromEnv}`);
  }

  return `${protocol}://${encodeURIComponent(redisUser || 'default')}:${encodeURIComponent(redisPass || '')}@${host}:${port}/${db}`;
}

function normalizeDumpPayload(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  throw new Error(`Redis DUMP returned a non-binary payload (${typeof payload}).`);
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });

  const dataSourcePreference = String(process.env.DATA_SOURCE_PREFERENCE || 'redis').trim().toLowerCase();
  if (dataSourcePreference !== 'redis') {
    log(`Skipping clone because DATA_SOURCE_PREFERENCE=${dataSourcePreference}.`);
    return;
  }

  if (!process.env.REDIS_URL) {
    log('Skipping clone because REDIS_URL is not configured.');
    return;
  }

  const sourceDb = String(
    process.env.EXPERIMENTAL_SOURCE_REDIS_DB
    || process.env.CONTROL_PLANE_SOURCE_REDIS_DB
    || '0',
  ).trim() || '0';
  const targetDb = String(
    process.env.REDIS_DB_EXPERIMENTAL
    || process.env.EXPERIMENTAL_TARGET_REDIS_DB
    || process.env.CONTROL_PLANE_TARGET_REDIS_DB
    || '1',
  ).trim() || '1';

  if (sourceDb === targetDb) {
    log(`Skipping clone because source DB ${sourceDb} and target DB ${targetDb} are identical.`);
    return;
  }

  const source = createClient({ url: buildRedisConnectionString(sourceDb) });
  const target = createClient({ url: buildRedisConnectionString(targetDb) });

  await source.connect();
  await target.connect();

  try {
    let copied = 0;
    let copyMethod: 'copy' | 'dump-restore' = 'copy';
    await target.flushDb();

    for await (const key of source.scanIterator()) {
      if (copyMethod === 'copy') {
        try {
          const copiedResult = await source.sendCommand<number>(['COPY', key, key, 'DB', targetDb, 'REPLACE']);
          copied += Number(copiedResult ?? 0);
          continue;
        } catch {
          copyMethod = 'dump-restore';
        }
      }

      const serializedValue = await source.sendCommand<Buffer | Uint8Array | ArrayBuffer | null>(
        ['DUMP', key],
        { returnBuffers: true } as any,
      );
      if (!serializedValue) continue;

      const serializedBuffer = normalizeDumpPayload(serializedValue);
      const ttlMs = Number(await source.sendCommand<number>(['PTTL', key]));
      await target.sendCommand(['RESTORE', key, ttlMs > 0 ? String(ttlMs) : '0', serializedBuffer as any, 'REPLACE'] as any);
      copied += 1;
    }

    log(`Cloned ${copied} key(s) from DB ${sourceDb} to DB ${targetDb} via ${copyMethod}.`);
  } finally {
    await source.quit().catch(() => undefined);
    await target.quit().catch(() => undefined);
  }
}

await main();
