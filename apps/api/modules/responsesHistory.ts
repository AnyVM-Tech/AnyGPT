import redis from './db.js';
import { buildResponsesOutputItems } from './openaiResponsesFormat.js';
import { readEnvNumber } from './tokenEstimation.js';

export type StoredResponsesHistoryEntry = {
  id: string;
  model: string;
  input_delta?: any[];
  input?: any[]; // Legacy full-snapshot field retained for backward compatibility.
  output: any[];
  output_text: string;
  created: number;
  previous_response_id?: string;
  replay_depth?: number;
  compacted?: boolean;
};

export type ResponsesHistoryMergeResult = {
  input: any[];
  replayDepth: number;
  itemCount: number;
};

export type ResponsesHistoryStoragePlan = {
  input_delta?: any[];
  input?: any[];
  previous_response_id?: string;
  replay_depth: number;
  compacted: boolean;
};

const RESPONSES_HISTORY_TTL_SECONDS = Math.max(60, readEnvNumber('RESPONSES_HISTORY_TTL_SECONDS', 60 * 60));
const RESPONSES_HISTORY_REDIS_PREFIX = 'api:responses_history:';
const RESPONSES_HISTORY_MEMORY_MAX_ENTRIES = Math.max(0, readEnvNumber('RESPONSES_HISTORY_MEMORY_MAX_ENTRIES', 128));
const RESPONSES_HISTORY_MAX_CHAIN_DEPTH = Math.max(1, readEnvNumber('RESPONSES_HISTORY_MAX_CHAIN_DEPTH', 64));
const RESPONSES_HISTORY_MAX_ITEMS = Math.max(128, readEnvNumber('RESPONSES_HISTORY_MAX_ITEMS', 4096));
const RESPONSES_HISTORY_MAX_STORAGE_BYTES = Math.max(
  256 * 1024,
  readEnvNumber('RESPONSES_HISTORY_MAX_STORAGE_BYTES', 4 * 1024 * 1024)
);
const RESPONSES_HISTORY_SNAPSHOT_INTERVAL = Math.max(2, readEnvNumber('RESPONSES_HISTORY_SNAPSHOT_INTERVAL', 12));
const RESPONSES_HISTORY_ARCHIVE_TTL_SECONDS = Math.max(
  RESPONSES_HISTORY_TTL_SECONDS,
  readEnvNumber('RESPONSES_HISTORY_ARCHIVE_TTL_SECONDS', 30 * 24 * 60 * 60)
);
const RESPONSES_HISTORY_ARCHIVE_REDIS_PREFIX = 'api:responses_history_archive:';
const responsesHistoryMemory = new Map<string, { expiresAt: number; entry: StoredResponsesHistoryEntry }>();

export function cloneResponsesHistoryValue<T>(value: T): T {
  if (typeof value === 'undefined') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getResponsesHistoryRedisKey(responseId: string): string {
  return `${RESPONSES_HISTORY_REDIS_PREFIX}${responseId}`;
}

function getResponsesHistoryArchiveRedisKey(responseId: string): string {
  return `${RESPONSES_HISTORY_ARCHIVE_REDIS_PREFIX}${responseId}`;
}

function cacheResponsesHistoryEntry(entry: StoredResponsesHistoryEntry): void {
  if (RESPONSES_HISTORY_MEMORY_MAX_ENTRIES <= 0) return;

  const normalizedId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!normalizedId) return;

  if (responsesHistoryMemory.has(normalizedId)) {
    responsesHistoryMemory.delete(normalizedId);
  }
  responsesHistoryMemory.set(normalizedId, {
    expiresAt: Date.now() + RESPONSES_HISTORY_TTL_SECONDS * 1000,
    entry,
  });

  while (responsesHistoryMemory.size > RESPONSES_HISTORY_MEMORY_MAX_ENTRIES) {
    const oldestKey = responsesHistoryMemory.keys().next().value;
    if (!oldestKey) break;
    responsesHistoryMemory.delete(oldestKey);
  }
}

function normalizeStoredResponsesHistoryEntry(raw: StoredResponsesHistoryEntry): StoredResponsesHistoryEntry {
  const normalizedId = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const replayDepthRaw = Number(raw?.replay_depth);
  const replayDepth =
    Number.isFinite(replayDepthRaw) && replayDepthRaw > 0
      ? Math.floor(replayDepthRaw)
      : 1;
  return {
    id: normalizedId,
    model: typeof raw?.model === 'string' ? raw.model : '',
    input_delta: Array.isArray(raw?.input_delta)
      ? cloneResponsesHistoryValue(raw.input_delta)
      : undefined,
    input: Array.isArray(raw?.input)
      ? cloneResponsesHistoryValue(raw.input)
      : undefined,
    output: Array.isArray(raw?.output)
      ? cloneResponsesHistoryValue(raw.output)
      : [],
    output_text: typeof raw?.output_text === 'string' ? raw.output_text : '',
    created: typeof raw?.created === 'number' ? raw.created : Math.floor(Date.now() / 1000),
    previous_response_id:
      typeof raw?.previous_response_id === 'string' && raw.previous_response_id.trim()
        ? raw.previous_response_id.trim()
        : undefined,
    replay_depth: replayDepth,
    compacted: raw?.compacted === true,
  };
}

function isLegacySnapshotEntry(entry: StoredResponsesHistoryEntry): boolean {
  return !Array.isArray(entry.input_delta) && Array.isArray(entry.input);
}

function getReplayDepth(entry: StoredResponsesHistoryEntry | null | undefined): number {
  if (!entry) return 0;
  const raw = Number(entry.replay_depth);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

async function loadResponsesHistoryArchiveEntry(responseId: string): Promise<StoredResponsesHistoryEntry | null> {
  const normalizedId = typeof responseId === 'string' ? responseId.trim() : '';
  if (!normalizedId || !redis) return null;

  try {
    const raw = await redis.get(getResponsesHistoryArchiveRedisKey(normalizedId));
    if (!raw) return null;
    return normalizeStoredResponsesHistoryEntry(JSON.parse(raw) as StoredResponsesHistoryEntry);
  } catch {
    return null;
  }
}

async function saveResponsesHistoryArchiveEntry(entry: StoredResponsesHistoryEntry): Promise<void> {
  const normalizedId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!normalizedId || !redis) return;

  const stored = normalizeStoredResponsesHistoryEntry({
    ...cloneResponsesHistoryValue(entry),
    id: normalizedId,
  });

  try {
    await redis.set(
      getResponsesHistoryArchiveRedisKey(normalizedId),
      JSON.stringify(stored),
      'EX',
      RESPONSES_HISTORY_ARCHIVE_TTL_SECONDS,
    );
  } catch (error: any) {
    console.warn(`[ResponsesHistory] Failed to persist archive ${normalizedId}: ${error?.message || error}`);
  }
}

async function touchResponsesHistoryArchiveEntry(entry: StoredResponsesHistoryEntry): Promise<void> {
  const normalizedId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!normalizedId || !redis) return;

  await saveResponsesHistoryArchiveEntry(entry);
}

async function touchResponsesHistoryEntry(entry: StoredResponsesHistoryEntry): Promise<StoredResponsesHistoryEntry> {
  const stored = normalizeStoredResponsesHistoryEntry(entry);
  cacheResponsesHistoryEntry(stored);
  await touchResponsesHistoryArchiveEntry(stored);

  if (!redis) return stored;

  try {
    await redis.set(
      getResponsesHistoryRedisKey(stored.id),
      JSON.stringify(stored),
      'EX',
      RESPONSES_HISTORY_TTL_SECONDS,
    );
  } catch (error: any) {
    console.warn(`[ResponsesHistory] Failed to refresh ${stored.id}: ${error?.message || error}`);
  }

  return stored;
}

export function pruneExpiredResponsesHistoryMemory(): void {
  const now = Date.now();
  for (const [key, cached] of responsesHistoryMemory) {
    if (cached.expiresAt <= now) responsesHistoryMemory.delete(key);
  }
}

export async function loadResponsesHistoryEntry(responseId: string): Promise<StoredResponsesHistoryEntry | null> {
  const normalizedId = typeof responseId === 'string' ? responseId.trim() : '';
  if (!normalizedId) return null;

  pruneExpiredResponsesHistoryMemory();
  const cached = responsesHistoryMemory.get(normalizedId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      const refreshed = await touchResponsesHistoryEntry(cached.entry);
      return cloneResponsesHistoryValue(refreshed);
    }
    responsesHistoryMemory.delete(normalizedId);
  }

  if (redis) {
    try {
      const raw = await redis.get(getResponsesHistoryRedisKey(normalizedId));
      if (raw) {
        const parsed = normalizeStoredResponsesHistoryEntry(
          JSON.parse(raw) as StoredResponsesHistoryEntry
        );
        const refreshed = await touchResponsesHistoryEntry(parsed);
        return cloneResponsesHistoryValue(refreshed);
      }
    } catch (error: any) {
      console.warn(`[ResponsesHistory] Failed to load ${normalizedId} from Redis: ${error?.message || error}`);
    }
  }

  const archived = await loadResponsesHistoryArchiveEntry(normalizedId);
  if (!archived) return null;

  const refreshed = await touchResponsesHistoryEntry(archived);
  return cloneResponsesHistoryValue(refreshed);
}

export async function saveResponsesHistoryEntry(entry: StoredResponsesHistoryEntry): Promise<void> {
  const normalizedId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!normalizedId) return;

  const stored = normalizeStoredResponsesHistoryEntry({
    ...cloneResponsesHistoryValue(entry),
    id: normalizedId,
  });
  cacheResponsesHistoryEntry(stored);
  await saveResponsesHistoryArchiveEntry(stored);

  if (!redis) return;

  try {
    await redis.set(
      getResponsesHistoryRedisKey(normalizedId),
      JSON.stringify(stored),
      'EX',
      RESPONSES_HISTORY_TTL_SECONDS,
    );
  } catch (error: any) {
    console.warn(`[ResponsesHistory] Failed to persist ${normalizedId}: ${error?.message || error}`);
  }
}

export function buildStoredResponsesHistoryOutput(outputText: string, toolCalls?: any[]): any[] {
  return buildResponsesOutputItems(outputText || '', toolCalls, {
    messageStatus: 'completed',
    functionCallStatus: 'completed',
  });
}

function countHistoryItems(items: any[]): number {
  return Array.isArray(items) ? items.length : 0;
}

function estimateResponsesHistoryStorageBytes(value: unknown): number {
  if (typeof value === 'undefined') return 0;

  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
  }
}

export function buildResponsesHistoryStoragePlan(params: {
  previousEntry?: StoredResponsesHistoryEntry | null;
  inputDelta: any[];
  fullInput: any[];
}): ResponsesHistoryStoragePlan {
  const previousReplayDepth = getReplayDepth(params.previousEntry);
  const nextReplayDepth = previousReplayDepth + 1;
  const shouldCompact = nextReplayDepth >= RESPONSES_HISTORY_SNAPSHOT_INTERVAL;

  if (shouldCompact) {
    return {
      input: cloneResponsesHistoryValue(params.fullInput || []),
      replay_depth: 1,
      compacted: true,
    };
  }

  return {
    input_delta: cloneResponsesHistoryValue(params.inputDelta || []),
    previous_response_id:
      typeof params.previousEntry?.id === 'string' && params.previousEntry.id.trim()
        ? params.previousEntry.id.trim()
        : undefined,
    replay_depth: Math.max(1, nextReplayDepth),
    compacted: false,
  };
}

export async function mergeResponsesHistoryInput(
  previousEntry: StoredResponsesHistoryEntry,
  nextInput: any[]
): Promise<ResponsesHistoryMergeResult> {
  const chain: StoredResponsesHistoryEntry[] = [];
  const visited = new Set<string>();
  let cursor: StoredResponsesHistoryEntry | null = normalizeStoredResponsesHistoryEntry(previousEntry);
  let depth = 0;

  while (cursor) {
    const normalizedId = typeof cursor.id === 'string' ? cursor.id.trim() : '';
    if (!normalizedId || visited.has(normalizedId)) {
      throw new Error('Responses history chain is invalid or cyclic.');
    }
    visited.add(normalizedId);
    chain.push(cursor);
    depth += 1;
    if (depth > RESPONSES_HISTORY_MAX_CHAIN_DEPTH) {
      throw new Error(
        `Responses history chain exceeded limit (${RESPONSES_HISTORY_MAX_CHAIN_DEPTH}). Start a new response thread.`
      );
    }

    if (isLegacySnapshotEntry(cursor) || !cursor.previous_response_id) break;

    cursor = await loadResponsesHistoryEntry(cursor.previous_response_id);
    if (!cursor) {
      throw new Error(
        `Stored previous_response_id '${chain[chain.length - 1]?.previous_response_id || ''}' could not be resolved.`
      );
    }
  }

  const merged: any[] = [];
  let storageBytes = 0;
  for (const entry of chain.reverse()) {
    const historicalInput = isLegacySnapshotEntry(entry)
      ? cloneResponsesHistoryValue(entry.input || [])
      : cloneResponsesHistoryValue(entry.input_delta || []);
    const historicalOutput = cloneResponsesHistoryValue(entry.output || []);
    storageBytes += estimateResponsesHistoryStorageBytes(historicalInput);
    storageBytes += estimateResponsesHistoryStorageBytes(historicalOutput);
    merged.push(...historicalInput, ...historicalOutput);
    if (countHistoryItems(merged) > RESPONSES_HISTORY_MAX_ITEMS) {
      throw new Error(
        `Responses history exceeded item limit (${RESPONSES_HISTORY_MAX_ITEMS}). Start a new response thread.`
      );
    }
    if (storageBytes > RESPONSES_HISTORY_MAX_STORAGE_BYTES) {
      throw new Error(
        `Responses history exceeded storage limit (${RESPONSES_HISTORY_MAX_STORAGE_BYTES} bytes). Start a new response thread.`
      );
    }
  }

  const clonedNextInput = cloneResponsesHistoryValue(nextInput || []);
  storageBytes += estimateResponsesHistoryStorageBytes(clonedNextInput);
  merged.push(...clonedNextInput);
  if (countHistoryItems(merged) > RESPONSES_HISTORY_MAX_ITEMS) {
    throw new Error(
      `Responses history exceeded item limit (${RESPONSES_HISTORY_MAX_ITEMS}). Start a new response thread.`
    );
  }
  if (storageBytes > RESPONSES_HISTORY_MAX_STORAGE_BYTES) {
    throw new Error(
      `Responses history exceeded storage limit (${RESPONSES_HISTORY_MAX_STORAGE_BYTES} bytes). Start a new response thread.`
    );
  }

  return {
    input: merged,
    replayDepth: chain.length + 1,
    itemCount: countHistoryItems(merged),
  };
}
