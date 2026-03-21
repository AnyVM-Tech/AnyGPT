import fs from 'node:fs';
import path from 'node:path';

import { Embeddings } from '@langchain/core/embeddings';
import { BaseStore, InMemoryStore, type Item } from '@langchain/langgraph';
import type { SearchItem } from '@langchain/langgraph-checkpoint';

type PersistedMemoryStoreFile = {
  version: 1;
  items: Array<{
    namespace: string[];
    key: string;
    value: Record<string, any>;
    createdAt: string;
    updatedAt: string;
  }>;
};

class LocalKeywordEmbeddings extends Embeddings<number[]> {
  private readonly dims: number;

  constructor(dims: number) {
    super({});
    this.dims = dims;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedText(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedText(text);
  }

  private embedText(text: string): number[] {
    const vector = Array.from({ length: this.dims }, () => 0);
    const tokens = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.length === 0) return vector;

    for (const token of tokens) {
      let hash = 0;
      for (let index = 0; index < token.length; index += 1) {
        hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
      }
      const bucket = Math.abs(hash) % this.dims;
      vector[bucket] += 1;
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) return vector;
    return vector.map((value) => value / magnitude);
  }
}

export class PersistentSemanticMemoryStore extends BaseStore {
  private readonly filePath: string;
  private readonly backingStore: InMemoryStore;
  private loaded = false;

  constructor(filePath: string) {
    super();
    this.filePath = path.resolve(filePath);
    this.backingStore = new InMemoryStore({
      index: {
        dims: 64,
        embeddings: new LocalKeywordEmbeddings(64) as unknown as Embeddings<number[]>,
        fields: ['memory', 'category', 'signalSignature', 'failureClass', 'resolution', '$'],
      },
    });
  }

  override async start(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) return;

    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedMemoryStoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) return;

    for (const item of parsed.items) {
      await this.backingStore.put(item.namespace, item.key, item.value);
    }
  }

  override async stop(): Promise<void> {
    await this.persist();
  }

  override async batch<Op extends any[]>(operations: Op): Promise<any> {
    await this.start();
    const result = await (this.backingStore.batch as any)(operations);
    if (operations.some((operation: any) => operation && 'value' in operation)) {
      await this.persist();
    }
    return result;
  }

  override async get(namespace: string[], key: string): Promise<Item | null> {
    await this.start();
    return this.backingStore.get(namespace, key);
  }

  override async search(namespacePrefix: string[], options?: { filter?: Record<string, any>; limit?: number; offset?: number; query?: string }): Promise<SearchItem[]> {
    await this.start();
    return this.backingStore.search(namespacePrefix, options);
  }

  override async put(namespace: string[], key: string, value: Record<string, any>, index?: false | string[]): Promise<void> {
    await this.start();
    await this.backingStore.put(namespace, key, value, index);
    await this.persist();
  }

  override async delete(namespace: string[], key: string): Promise<void> {
    await this.start();
    await this.backingStore.delete(namespace, key);
    await this.persist();
  }

  override async listNamespaces(options?: { prefix?: string[]; suffix?: string[]; maxDepth?: number; limit?: number; offset?: number }): Promise<string[][]> {
    await this.start();
    return this.backingStore.listNamespaces(options);
  }

  private async persist(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const namespaces = await this.backingStore.listNamespaces({ limit: 1000, offset: 0 });
    const seen = new Set<string>();
    const items: PersistedMemoryStoreFile['items'] = [];

    for (const namespace of namespaces) {
      const results = await this.backingStore.search(namespace, { limit: 200, offset: 0 });
      for (const item of results) {
        const identity = `${item.namespace.join('/')}:${item.key}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push({
          namespace: item.namespace,
          key: item.key,
          value: item.value,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        });
      }
    }

    const payload: PersistedMemoryStoreFile = {
      version: 1,
      items,
    };
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}
