import { createHash } from 'node:crypto';
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

type SearchOptions = {
  filter?: Record<string, any>;
  limit?: number;
  offset?: number;
  query?: string;
};

const SEMANTIC_MEMORY_INDEX_DIMS = 256;
const SEMANTIC_MEMORY_NAMESPACE_PAGE_SIZE = 128;
const SEMANTIC_MEMORY_ITEM_PAGE_SIZE = 128;
const SEMANTIC_MEMORY_SEARCH_WINDOW = 96;
const SEMANTIC_MEMORY_TEXT_FIELD_MAX_CHARS = 360;
const SEMANTIC_MEMORY_CONTEXT_FIELD_MAX_CHARS = 240;
const SEMANTIC_MEMORY_SEARCH_TEXT_MAX_CHARS = 1_200;
const SEMANTIC_MEMORY_KEYWORD_LIMIT = 16;
const SEMANTIC_MEMORY_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SEMANTIC_MEMORY_REMOTE_EMBEDDINGS_TIMEOUT_MS = Math.max(
  1_000,
  Math.floor(Number(process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_TIMEOUT_MS) || 15_000),
);
const SEMANTIC_MEMORY_REMOTE_EMBEDDINGS_BATCH_SIZE = Math.max(
  1,
  Math.min(32, Math.floor(Number(process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_BATCH_SIZE) || 12)),
);
const SEMANTIC_MEMORY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'with',
]);

function normalizeWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseBooleanEnv(value: unknown, fallback: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function truncateTextMiddle(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;

  const marker = ` …[truncated ${normalized.length - maxChars} chars]… `;
  const availableChars = maxChars - marker.length;
  if (availableChars <= 32) {
    return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  const headChars = Math.ceil(availableChars / 2);
  const tailChars = Math.floor(availableChars / 2);
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(normalized.length - tailChars)}`;
}

function normalizeSummaryText(value: unknown, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return truncateTextMiddle(normalized, maxChars);
}

function normalizeSearchText(value: unknown, maxChars: number = SEMANTIC_MEMORY_SEARCH_TEXT_MAX_CHARS): string {
  return normalizeSummaryText(value, maxChars).toLowerCase();
}

function tokenizeText(value: unknown): string[] {
  const normalized = normalizeSearchText(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_:/.-]+/g, ' ');
  if (!normalized) return [];

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEMANTIC_MEMORY_STOP_WORDS.has(token));
}

function collectKeywords(values: unknown[], limit: number = SEMANTIC_MEMORY_KEYWORD_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    for (const token of tokenizeText(value)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => (
      right[1] - left[1]
      || right[0].length - left[0].length
      || left[0].localeCompare(right[0])
    ))
    .slice(0, limit)
    .map(([token]) => token);
}

function fingerprintText(value: unknown): string {
  return createHash('sha256').update(normalizeSearchText(value) || 'semantic-memory').digest('base64url').slice(0, 24);
}

function normalizeTimestamp(value: unknown, fallback?: string): string {
  const candidate = String(value || fallback || '').trim();
  const timestamp = Date.parse(candidate);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (fallback) return normalizeTimestamp(fallback);
  return new Date().toISOString();
}

function parseTimestamp(value: unknown, fallback?: number): number {
  const timestamp = Date.parse(String(value || ''));
  if (Number.isFinite(timestamp)) return timestamp;
  return typeof fallback === 'number' ? fallback : 0;
}

function isSemanticMemoryValue(value: Record<string, any>): boolean {
  return [
    'memory',
    'signalSignature',
    'failureClass',
    'resolution',
    'category',
    'signalKeywords',
    'observationCount',
    'firstObservedAt',
    'lastObservedAt',
  ].some((key) => key in (value || {}));
}

function buildSemanticMemorySearchText(value: Record<string, any>): string {
  return truncateTextMiddle(
    [
      value.memory,
      value.category,
      value.failureClass,
      value.signalSignature,
      value.resolution,
      Array.isArray(value.signalKeywords) ? value.signalKeywords.join(' ') : '',
      value.source,
    ]
      .map((entry) => normalizeWhitespace(entry))
      .filter(Boolean)
      .join('\n'),
    SEMANTIC_MEMORY_SEARCH_TEXT_MAX_CHARS,
  );
}

function stripDerivedSemanticMemoryFields(value: Record<string, any>): Record<string, any> {
  const normalized = { ...(value || {}) };
  delete normalized.searchText;
  delete normalized.memoryFingerprint;
  return normalized;
}

function normalizeSemanticMemoryValue(
  value: Record<string, any>,
  timestamps?: { createdAt?: string; updatedAt?: string },
): Record<string, any> {
  if (!value || typeof value !== 'object') return {};
  if (!isSemanticMemoryValue(value)) return { ...value };

  const memory = normalizeSummaryText(value.memory, SEMANTIC_MEMORY_TEXT_FIELD_MAX_CHARS);
  const category = normalizeSummaryText(value.category ?? value.failureClass, 96) || 'general';
  const failureClass = normalizeSummaryText(value.failureClass ?? value.category, 96) || category;
  const signalSignature = normalizeSummaryText(value.signalSignature, SEMANTIC_MEMORY_TEXT_FIELD_MAX_CHARS);
  const resolution = normalizeSummaryText(value.resolution, SEMANTIC_MEMORY_CONTEXT_FIELD_MAX_CHARS);
  const source = normalizeSummaryText(value.source, 96) || 'runner-learning';
  const firstObservedAt = normalizeTimestamp(value.firstObservedAt, timestamps?.createdAt);
  const lastObservedAt = normalizeTimestamp(value.lastObservedAt, timestamps?.updatedAt || firstObservedAt);
  const observationCount = Math.max(1, Math.floor(Number(value.observationCount) || 1));
  const signalKeywords = Array.from(new Set([
    ...(
      Array.isArray(value.signalKeywords)
        ? value.signalKeywords.map((entry) => normalizeWhitespace(entry)).filter(Boolean)
        : []
    ),
    ...collectKeywords([memory, signalSignature, resolution, failureClass, category]),
  ])).slice(0, SEMANTIC_MEMORY_KEYWORD_LIMIT);

  const normalized = {
    ...value,
    category,
    memory,
    signalSignature,
    failureClass,
    resolution,
    source,
    signalKeywords,
    observationCount,
    firstObservedAt,
    lastObservedAt,
    memoryFingerprint: fingerprintText(memory || failureClass),
  };

  return {
    ...normalized,
    searchText: buildSemanticMemorySearchText(normalized),
  };
}

function mergeSemanticMemoryValues(current: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
  const currentTimestamp = parseTimestamp(current.lastObservedAt || current.updatedAt);
  const incomingTimestamp = parseTimestamp(incoming.lastObservedAt || incoming.updatedAt);
  const latest = incomingTimestamp >= currentTimestamp ? incoming : current;
  const earliest = latest === incoming ? current : incoming;

  return normalizeSemanticMemoryValue({
    ...earliest,
    ...latest,
    category: latest.category || earliest.category || 'general',
    failureClass: latest.failureClass || earliest.failureClass || latest.category || earliest.category || 'general',
    memory: latest.memory || earliest.memory || '',
    signalSignature: latest.signalSignature || earliest.signalSignature || '',
    resolution: latest.resolution || earliest.resolution || '',
    source: latest.source || earliest.source || 'runner-learning',
    observationCount: Math.max(1, Math.floor(Number(current.observationCount) || 1))
      + Math.max(1, Math.floor(Number(incoming.observationCount) || 1)),
    firstObservedAt: normalizeTimestamp(
      parseTimestamp(current.firstObservedAt) <= parseTimestamp(incoming.firstObservedAt)
        ? current.firstObservedAt
        : incoming.firstObservedAt,
      current.firstObservedAt || incoming.firstObservedAt,
    ),
    lastObservedAt: normalizeTimestamp(
      parseTimestamp(current.lastObservedAt) >= parseTimestamp(incoming.lastObservedAt)
        ? current.lastObservedAt
        : incoming.lastObservedAt,
      current.lastObservedAt || incoming.lastObservedAt,
    ),
    signalKeywords: Array.from(new Set([
      ...(Array.isArray(current.signalKeywords) ? current.signalKeywords : []),
      ...(Array.isArray(incoming.signalKeywords) ? incoming.signalKeywords : []),
    ])).slice(0, SEMANTIC_MEMORY_KEYWORD_LIMIT),
  });
}

function compareSearchItemsByFreshness(left: SearchItem, right: SearchItem): number {
  const leftTimestamp = parseTimestamp(left.value?.lastObservedAt, left.updatedAt.getTime());
  const rightTimestamp = parseTimestamp(right.value?.lastObservedAt, right.updatedAt.getTime());
  if (rightTimestamp !== leftTimestamp) return rightTimestamp - leftTimestamp;

  const leftObservationCount = Math.max(1, Math.floor(Number(left.value?.observationCount) || 1));
  const rightObservationCount = Math.max(1, Math.floor(Number(right.value?.observationCount) || 1));
  if (rightObservationCount !== leftObservationCount) return rightObservationCount - leftObservationCount;

  return `${left.namespace.join('/')}:${left.key}`.localeCompare(`${right.namespace.join('/')}:${right.key}`);
}

function compareRankedResults(left: SearchItem, right: SearchItem): number {
  const leftScore = typeof left.score === 'number' ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = typeof right.score === 'number' ? right.score : Number.NEGATIVE_INFINITY;
  if (rightScore !== leftScore) return rightScore - leftScore;
  return compareSearchItemsByFreshness(left, right);
}

function scoreLexicalOverlap(text: string, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const tokenSet = new Set(tokenizeText(text));
  if (tokenSet.size === 0) return 0;

  let matches = 0;
  for (const token of queryTokens) {
    if (tokenSet.has(token)) matches += 1;
  }
  return matches / queryTokens.length;
}

function scorePhraseMatch(text: string, query: string): number {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query, 240);
  if (!normalizedText || !normalizedQuery) return 0;
  if (normalizedText.includes(normalizedQuery)) return 1;

  const fragments = normalizedQuery.split(/\s+/).filter((fragment) => fragment.length >= 4);
  if (fragments.length === 0) return 0;
  const matchedFragments = fragments.filter((fragment) => normalizedText.includes(fragment)).length;
  return matchedFragments / fragments.length;
}

function scoreRecency(item: SearchItem): number {
  const lastObservedAt = parseTimestamp(item.value?.lastObservedAt, item.updatedAt.getTime());
  if (!lastObservedAt) return 0;
  const ageMs = Math.max(0, Date.now() - lastObservedAt);
  return Math.max(0, 1 - Math.min(1, ageMs / SEMANTIC_MEMORY_RECENCY_WINDOW_MS));
}

function scoreObservationWeight(item: SearchItem): number {
  const observationCount = Math.max(1, Math.floor(Number(item.value?.observationCount) || 1));
  return Math.min(1, Math.log2(observationCount + 1) / 5);
}

export function buildSemanticMemoryRecordKey(input: {
  memory?: unknown;
  failureClass?: unknown;
  category?: unknown;
  key?: unknown;
}): string {
  const category = normalizeSearchText(input.failureClass ?? input.category, 96) || 'general';
  const memorySeed = normalizeSearchText(input.memory, SEMANTIC_MEMORY_TEXT_FIELD_MAX_CHARS);
  if (!memorySeed) {
    return normalizeWhitespace(input.key) || `${category}:${fingerprintText(category)}`;
  }
  return `${category}:${fingerprintText(memorySeed)}`;
}

type RemoteEmbeddingsConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  dims: number;
  timeoutMs: number;
  batchSize: number;
  useDimensionsParameter: boolean;
};

function resolveRemoteEmbeddingsConfig(dims: number): RemoteEmbeddingsConfig | null {
  const apiKey = normalizeWhitespace(
    process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_API_KEY
    || process.env.OPENAI_API_KEY,
  );
  const baseUrl = normalizeWhitespace(
    process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_BASE_URL
    || (apiKey ? 'https://api.openai.com/v1' : ''),
  ).replace(/\/+$/, '');
  const model = normalizeWhitespace(
    process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_MODEL
    || 'text-embedding-3-large',
  );
  const remoteEnabled = parseBooleanEnv(
    process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_ENABLED,
    Boolean(apiKey && baseUrl && model),
  );
  if (!remoteEnabled || !apiKey || !baseUrl || !model) return null;

  return {
    apiKey,
    baseUrl,
    model,
    dims,
    timeoutMs: SEMANTIC_MEMORY_REMOTE_EMBEDDINGS_TIMEOUT_MS,
    batchSize: SEMANTIC_MEMORY_REMOTE_EMBEDDINGS_BATCH_SIZE,
    useDimensionsParameter: parseBooleanEnv(
      process.env.CONTROL_PLANE_SEMANTIC_EMBEDDINGS_USE_DIMENSIONS,
      /text-embedding-3/i.test(model),
    ),
  };
}

function coerceEmbeddingDimensions(vector: number[], dims: number): number[] {
  const adjusted = Array.from({ length: dims }, (_, index) => {
    const value = Number(vector[index] ?? 0);
    return Number.isFinite(value) ? value : 0;
  });
  const magnitude = Math.sqrt(adjusted.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) return adjusted;
  return adjusted.map((value) => value / magnitude);
}

class LocalSemanticEmbeddings extends Embeddings<number[]> {
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
    const tokens = tokenizeText(text);
    if (tokens.length === 0) return vector;

    const featureWeights = new Map<string, number>();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      featureWeights.set(`tok:${token}`, (featureWeights.get(`tok:${token}`) || 0) + 1.2);

      if (token.length >= 5) {
        for (let offset = 0; offset <= token.length - 3; offset += 1) {
          const trigram = token.slice(offset, offset + 3);
          featureWeights.set(`tri:${trigram}`, (featureWeights.get(`tri:${trigram}`) || 0) + 0.25);
        }
      }

      if (index + 1 < tokens.length) {
        const bigram = `${token}_${tokens[index + 1]}`;
        featureWeights.set(`bi:${bigram}`, (featureWeights.get(`bi:${bigram}`) || 0) + 0.75);
      }
    }

    for (const [feature, weight] of featureWeights.entries()) {
      let hash = 2166136261;
      for (let index = 0; index < feature.length; index += 1) {
        hash ^= feature.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      const bucket = Math.abs(hash) % this.dims;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[bucket] += weight * sign;
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) return vector;
    return vector.map((value) => value / magnitude);
  }
}

class OpenAiCompatibleSemanticEmbeddings extends Embeddings<number[]> {
  private readonly config: RemoteEmbeddingsConfig;

  constructor(config: RemoteEmbeddingsConfig) {
    super({});
    this.config = config;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.config.batchSize) {
      const batch = texts.slice(offset, offset + this.config.batchSize);
      vectors.push(...await this.embedBatch(batch));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector || Array.from({ length: this.config.dims }, () => 0);
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const payload: Record<string, unknown> = {
      input: texts,
      model: this.config.model,
      encoding_format: 'float',
    };
    if (this.config.useDimensionsParameter) {
      payload.dimensions = this.config.dims;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = normalizeWhitespace(await response.text().catch(() => ''));
        throw new Error(`Semantic embeddings request failed (${response.status}): ${bodyText || response.statusText}`);
      }

      const parsed = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const rows = Array.isArray(parsed?.data) ? parsed.data : [];
      return texts.map((_, index) => coerceEmbeddingDimensions(
        Array.isArray(rows[index]?.embedding) ? rows[index]?.embedding || [] : [],
        this.config.dims,
      ));
    } finally {
      clearTimeout(timeout);
    }
  }
}

class AdaptiveSemanticEmbeddings extends Embeddings<number[]> {
  private readonly local: LocalSemanticEmbeddings;
  private readonly remote: OpenAiCompatibleSemanticEmbeddings | null;
  private remoteDisabled = false;

  constructor(dims: number) {
    super({});
    this.local = new LocalSemanticEmbeddings(dims);
    const remoteConfig = resolveRemoteEmbeddingsConfig(dims);
    this.remote = remoteConfig ? new OpenAiCompatibleSemanticEmbeddings(remoteConfig) : null;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (this.remote && !this.remoteDisabled) {
      try {
        return await this.remote.embedDocuments(texts);
      } catch {
        this.remoteDisabled = true;
      }
    }
    return this.local.embedDocuments(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    if (this.remote && !this.remoteDisabled) {
      try {
        return await this.remote.embedQuery(text);
      } catch {
        this.remoteDisabled = true;
      }
    }
    return this.local.embedQuery(text);
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
        dims: SEMANTIC_MEMORY_INDEX_DIMS,
        embeddings: new AdaptiveSemanticEmbeddings(SEMANTIC_MEMORY_INDEX_DIMS) as unknown as Embeddings<number[]>,
        fields: ['searchText', 'memory', 'signalKeywords[*]', 'category', 'failureClass', 'resolution', 'signalSignature'],
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

    const mergedItems = new Map<string, PersistedMemoryStoreFile['items'][number]>();
    let needsRewrite = false;

    for (const item of parsed.items) {
      const normalizedValue = normalizeSemanticMemoryValue(item.value || {}, {
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
      const normalizedKey = isSemanticMemoryValue(normalizedValue)
        ? buildSemanticMemoryRecordKey({
            memory: normalizedValue.memory,
            failureClass: normalizedValue.failureClass,
            category: normalizedValue.category,
            key: item.key,
          })
        : normalizeWhitespace(item.key);
      const identity = `${item.namespace.join('/')}:${normalizedKey}`;
      const existing = mergedItems.get(identity);
      const createdAt = normalizeTimestamp(
        normalizedValue.firstObservedAt,
        item.createdAt,
      );
      const updatedAt = normalizeTimestamp(
        normalizedValue.lastObservedAt,
        item.updatedAt,
      );

      if (existing) {
        const mergedCreatedAt = parseTimestamp(existing.createdAt) <= parseTimestamp(createdAt)
          ? existing.createdAt
          : createdAt;
        const mergedUpdatedAt = parseTimestamp(existing.updatedAt) >= parseTimestamp(updatedAt)
          ? existing.updatedAt
          : updatedAt;
        mergedItems.set(identity, {
          namespace: item.namespace,
          key: normalizedKey,
          value: mergeSemanticMemoryValues(existing.value, normalizedValue),
          createdAt: normalizeTimestamp(mergedCreatedAt, createdAt),
          updatedAt: normalizeTimestamp(mergedUpdatedAt, updatedAt),
        });
        needsRewrite = true;
        continue;
      }

      mergedItems.set(identity, {
        namespace: item.namespace,
        key: normalizedKey,
        value: normalizedValue,
        createdAt,
        updatedAt,
      });

      if (
        normalizedKey !== item.key
        || JSON.stringify(stripDerivedSemanticMemoryFields(normalizedValue)) !== JSON.stringify(stripDerivedSemanticMemoryFields(item.value || {}))
      ) {
        needsRewrite = true;
      }
    }

    for (const item of mergedItems.values()) {
      await this.backingStore.put(item.namespace, item.key, item.value);
    }

    if (needsRewrite || mergedItems.size !== parsed.items.length) {
      await this.persist();
    }
  }

  override async stop(): Promise<void> {
    await this.persist();
  }

  override async batch<Op extends any[]>(operations: Op): Promise<any> {
    await this.start();
    const normalizedOperations = operations.map((operation: any) => {
      if (!operation || !('value' in operation) || operation.value === null || typeof operation.value !== 'object') {
        return operation;
      }
      return {
        ...operation,
        value: normalizeSemanticMemoryValue(operation.value),
      };
    }) as Op;
    const result = await (this.backingStore.batch as any)(normalizedOperations);
    if (normalizedOperations.some((operation: any) => operation && 'value' in operation)) {
      await this.persist();
    }
    return result;
  }

  override async get(namespace: string[], key: string): Promise<Item | null> {
    await this.start();
    return this.backingStore.get(namespace, key);
  }

  override async search(namespacePrefix: string[], options: SearchOptions = {}): Promise<SearchItem[]> {
    await this.start();
    const limit = Math.max(1, Math.floor(Number(options.limit) || 10));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const query = normalizeWhitespace(options.query);
    const candidates = (await this.collectItems(namespacePrefix, options.filter))
      .map((item) => ({
        ...item,
        value: normalizeSemanticMemoryValue(item.value || {}, {
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        }),
      }))
      .sort(compareSearchItemsByFreshness);

    if (!query) {
      return candidates.slice(offset, offset + limit).map((item) => ({
        ...item,
        score: undefined,
      }));
    }

    const semanticMatches = await this.backingStore.search(namespacePrefix, {
      filter: options.filter,
      query,
      limit: Math.max(offset + limit, SEMANTIC_MEMORY_SEARCH_WINDOW),
      offset: 0,
    });
    const semanticScores = new Map<string, number>();
    for (const item of semanticMatches) {
      const identity = `${item.namespace.join('/')}:${item.key}`;
      const score = typeof item.score === 'number' ? item.score : 0;
      if (!semanticScores.has(identity) || score > (semanticScores.get(identity) || 0)) {
        semanticScores.set(identity, score);
      }
    }

    const queryTokens = tokenizeText(query);
    const ranked = candidates
      .map((item) => {
        const identity = `${item.namespace.join('/')}:${item.key}`;
        const semanticScore = semanticScores.get(identity) || 0;
        const lexicalScore = scoreLexicalOverlap(item.value?.searchText || '', queryTokens);
        const phraseScore = scorePhraseMatch(item.value?.searchText || '', query);
        const recencyScore = scoreRecency(item);
        const observationScore = scoreObservationWeight(item);
        const score = (
          (semanticScore * 0.62)
          + (lexicalScore * 0.22)
          + (phraseScore * 0.10)
          + (recencyScore * 0.04)
          + (observationScore * 0.02)
        );
        return {
          ...item,
          score,
        };
      })
      .sort(compareRankedResults);

    return ranked.slice(offset, offset + limit);
  }

  override async put(namespace: string[], key: string, value: Record<string, any>, index?: false | string[]): Promise<void> {
    await this.start();
    await this.backingStore.put(namespace, key, normalizeSemanticMemoryValue(value), index);
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

  private async collectNamespaces(prefix?: string[]): Promise<string[][]> {
    const namespaces: string[][] = [];
    let offset = 0;
    while (true) {
      const batch = await this.backingStore.listNamespaces({
        ...(prefix ? { prefix } : {}),
        limit: SEMANTIC_MEMORY_NAMESPACE_PAGE_SIZE,
        offset,
      });
      if (batch.length === 0) break;
      namespaces.push(...batch);
      if (batch.length < SEMANTIC_MEMORY_NAMESPACE_PAGE_SIZE) break;
      offset += batch.length;
    }
    return namespaces;
  }

  private async collectItems(namespacePrefix: string[], filter?: Record<string, any>): Promise<SearchItem[]> {
    const namespaces = await this.collectNamespaces(namespacePrefix);
    const items: SearchItem[] = [];
    const seen = new Set<string>();

    for (const namespace of namespaces) {
      let offset = 0;
      while (true) {
        const batch = await this.backingStore.search(namespace, {
          filter,
          limit: SEMANTIC_MEMORY_ITEM_PAGE_SIZE,
          offset,
        });
        for (const item of batch) {
          const identity = `${item.namespace.join('/')}:${item.key}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          items.push(item);
        }
        if (batch.length < SEMANTIC_MEMORY_ITEM_PAGE_SIZE) break;
        offset += batch.length;
      }
    }

    return items;
  }

  private async persist(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const namespaces = await this.collectNamespaces();
    const seen = new Set<string>();
    const items: PersistedMemoryStoreFile['items'] = [];

    for (const namespace of namespaces) {
      const results = await this.collectItems(namespace);
      for (const item of results) {
        const identity = `${item.namespace.join('/')}:${item.key}`;
        if (seen.has(identity)) continue;
        seen.add(identity);

        const normalizedValue = normalizeSemanticMemoryValue(item.value || {}, {
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        });
        const createdAt = normalizeTimestamp(
          normalizedValue.firstObservedAt,
          item.createdAt.toISOString(),
        );
        const updatedAt = normalizeTimestamp(
          normalizedValue.lastObservedAt,
          item.updatedAt.toISOString(),
        );

        items.push({
          namespace: item.namespace,
          key: item.key,
          value: stripDerivedSemanticMemoryFields(normalizedValue),
          createdAt,
          updatedAt,
        });
      }
    }

    items.sort((left, right) => (
      left.namespace.join('/').localeCompare(right.namespace.join('/'))
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.key.localeCompare(right.key)
    ));

    const payload: PersistedMemoryStoreFile = {
      version: 1,
      items,
    };
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}
