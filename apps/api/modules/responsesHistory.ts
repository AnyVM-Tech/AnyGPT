import redis from './db.js';
import { buildResponsesOutputItems } from './openaiResponsesFormat.js';
import { readEnvNumber } from './tokenEstimation.js';

export type StoredResponsesHistoryEntry = {
  id: string;
  model: string;
  input: any[];
  output: any[];
  output_text: string;
  created: number;
};

const RESPONSES_HISTORY_TTL_SECONDS = Math.max(60, readEnvNumber('RESPONSES_HISTORY_TTL_SECONDS', 60 * 60));
const RESPONSES_HISTORY_REDIS_PREFIX = 'api:responses_history:';
const responsesHistoryMemory = new Map<string, { expiresAt: number; entry: StoredResponsesHistoryEntry }>();

export function cloneResponsesHistoryValue<T>(value: T): T {
  if (typeof value === 'undefined') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getResponsesHistoryRedisKey(responseId: string): string {
  return `${RESPONSES_HISTORY_REDIS_PREFIX}${responseId}`;
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
    if (cached.expiresAt > Date.now()) return cloneResponsesHistoryValue(cached.entry);
    responsesHistoryMemory.delete(normalizedId);
  }

  if (!redis) return null;

  try {
    const raw = await redis.get(getResponsesHistoryRedisKey(normalizedId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredResponsesHistoryEntry;
    responsesHistoryMemory.set(normalizedId, {
      expiresAt: Date.now() + RESPONSES_HISTORY_TTL_SECONDS * 1000,
      entry: parsed,
    });
    return cloneResponsesHistoryValue(parsed);
  } catch (error: any) {
    console.warn(`[ResponsesHistory] Failed to load ${normalizedId}: ${error?.message || error}`);
    return null;
  }
}

export async function saveResponsesHistoryEntry(entry: StoredResponsesHistoryEntry): Promise<void> {
  const normalizedId = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!normalizedId) return;

  const stored: StoredResponsesHistoryEntry = {
    ...cloneResponsesHistoryValue(entry),
    id: normalizedId,
  };
  responsesHistoryMemory.set(normalizedId, {
    expiresAt: Date.now() + RESPONSES_HISTORY_TTL_SECONDS * 1000,
    entry: stored,
  });

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

export function mergeResponsesHistoryInput(previousEntry: StoredResponsesHistoryEntry, nextInput: any[]): any[] {
  return [
    ...cloneResponsesHistoryValue(previousEntry.input || []),
    ...cloneResponsesHistoryValue(previousEntry.output || []),
    ...cloneResponsesHistoryValue(nextInput || []),
  ];
}
