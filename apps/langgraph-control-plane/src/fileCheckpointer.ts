import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

import { MemorySaver } from '@langchain/langgraph-checkpoint';

type InMemoryStorage = Record<string, Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>>;
type InMemoryWrites = Record<string, Record<string, [string, string, Uint8Array]>>;

type PersistedStorage = Record<string, Record<string, Record<string, [string, string, string | undefined]>>>;
type PersistedWrites = Record<string, Record<string, [string, string, string]>>;

type PersistedMemorySnapshot = {
  version: 1;
  storage: PersistedStorage;
  writes: PersistedWrites;
};

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(String(value || ''), 'base64'));
}

function serializeStorage(storage: InMemoryStorage): PersistedStorage {
  return Object.fromEntries(
    Object.entries(storage || {}).map(([threadId, namespaces]) => [
      threadId,
      Object.fromEntries(
        Object.entries(namespaces || {}).map(([namespace, checkpoints]) => [
          namespace,
          Object.fromEntries(
            Object.entries(checkpoints || {}).map(([checkpointId, [checkpoint, metadata, parentCheckpointId]]) => [
              checkpointId,
              [encodeBytes(checkpoint), encodeBytes(metadata), parentCheckpointId],
            ]),
          ),
        ]),
      ),
    ]),
  );
}

function restoreStorage(storage: PersistedStorage | undefined): InMemoryStorage {
  return Object.fromEntries(
    Object.entries(storage || {}).map(([threadId, namespaces]) => [
      threadId,
      Object.fromEntries(
        Object.entries(namespaces || {}).map(([namespace, checkpoints]) => [
          namespace,
          Object.fromEntries(
            Object.entries(checkpoints || {}).map(([checkpointId, [checkpoint, metadata, parentCheckpointId]]) => [
              checkpointId,
              [decodeBytes(checkpoint), decodeBytes(metadata), parentCheckpointId],
            ]),
          ),
        ]),
      ),
    ]),
  );
}

function serializeWrites(writes: InMemoryWrites): PersistedWrites {
  return Object.fromEntries(
    Object.entries(writes || {}).map(([outerKey, innerWrites]) => [
      outerKey,
      Object.fromEntries(
        Object.entries(innerWrites || {}).map(([innerKey, [taskId, channel, value]]) => [
          innerKey,
          [taskId, channel, encodeBytes(value)],
        ]),
      ),
    ]),
  );
}

function restoreWrites(writes: PersistedWrites | undefined): InMemoryWrites {
  return Object.fromEntries(
    Object.entries(writes || {}).map(([outerKey, innerWrites]) => [
      outerKey,
      Object.fromEntries(
        Object.entries(innerWrites || {}).map(([innerKey, [taskId, channel, value]]) => [
          innerKey,
          [taskId, channel, decodeBytes(value)],
        ]),
      ),
    ]),
  );
}

export class FileMemorySaver extends MemorySaver {
  readonly filePath: string;
  private loaded = false;

  constructor(filePath: string) {
    super();
    this.filePath = path.resolve(filePath);
  }

  private readSnapshot(): PersistedMemorySnapshot | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as Partial<PersistedMemorySnapshot>;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported checkpoint snapshot version in ${this.filePath}: ${String(parsed.version)}`);
    }

    return {
      version: 1,
      storage: parsed.storage || {},
      writes: parsed.writes || {},
    };
  }

  private buildSnapshot(): PersistedMemorySnapshot {
    return {
      version: 1,
      storage: serializeStorage(this.storage as InMemoryStorage),
      writes: serializeWrites(this.writes as InMemoryWrites),
    };
  }

  private async persist(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.buildSnapshot(), null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  async setup(): Promise<void> {
    if (this.loaded) return;

    const snapshot = this.readSnapshot();
    this.storage = restoreStorage(snapshot?.storage);
    this.writes = restoreWrites(snapshot?.writes);
    this.loaded = true;

    if (!snapshot) {
      await this.persist();
    }
  }

  async getTuple(config: any): Promise<any> {
    await this.setup();
    return super.getTuple(config);
  }

  async *list(config: any, options?: any): AsyncGenerator<any> {
    await this.setup();
    for await (const item of super.list(config, options)) {
      yield item;
    }
  }

  async put(config: any, checkpoint: any, metadata: any, _newVersions?: any): Promise<any> {
    await this.setup();
    const result = await super.put(config, checkpoint, metadata);
    await this.persist();
    return result;
  }

  async putWrites(config: any, writes: any, taskId: string): Promise<void> {
    await this.setup();
    await super.putWrites(config, writes, taskId);
    await this.persist();
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.setup();
    await super.deleteThread(threadId);
    await this.persist();
  }
}
