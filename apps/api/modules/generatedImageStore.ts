import { randomUUID } from 'node:crypto';

type CachedGeneratedImage = {
  mimeType: string;
  data: Buffer;
  createdAt: number;
  expiresAt: number;
  size: number;
};

const GENERATED_IMAGE_TTL_MS = Math.max(60_000, Number(process.env.GENERATED_IMAGE_TTL_MS ?? 60 * 60 * 1000));
const GENERATED_IMAGE_MAX_ITEMS = Math.max(16, Number(process.env.GENERATED_IMAGE_MAX_ITEMS ?? 256));
const GENERATED_IMAGE_MAX_TOTAL_BYTES = Math.max(8 * 1024 * 1024, Number(process.env.GENERATED_IMAGE_MAX_TOTAL_BYTES ?? 256 * 1024 * 1024));
const GENERATED_IMAGE_ROUTE_PREFIX = '/v1/generated-images';

const generatedImageStore = new Map<string, CachedGeneratedImage>();
let generatedImageStoreBytes = 0;

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || '').trim().toLowerCase();
  if (!mimeType.startsWith('image/')) return null;
  const base64 = String(match[2] || '').replace(/\s+/g, '');
  if (!base64) return null;
  return { mimeType, base64 };
}

function evictGeneratedImage(id: string): void {
  const existing = generatedImageStore.get(id);
  if (!existing) return;
  generatedImageStore.delete(id);
  generatedImageStoreBytes = Math.max(0, generatedImageStoreBytes - existing.size);
}

function pruneExpiredGeneratedImages(now: number = Date.now()): void {
  for (const [id, asset] of generatedImageStore.entries()) {
    if (asset.expiresAt <= now) {
      evictGeneratedImage(id);
    }
  }
}

function pruneGeneratedImageCapacity(nextSize: number): void {
  pruneExpiredGeneratedImages();
  const entriesByAge = Array.from(generatedImageStore.entries())
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  while (
    (generatedImageStore.size >= GENERATED_IMAGE_MAX_ITEMS
      || generatedImageStoreBytes + nextSize > GENERATED_IMAGE_MAX_TOTAL_BYTES)
    && entriesByAge.length > 0
  ) {
    const oldest = entriesByAge.shift();
    if (!oldest) break;
    evictGeneratedImage(oldest[0]);
  }
}

function resolvePublicOrigin(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  const host = (headers['x-forwarded-host'] || headers['host'] || '').split(',')[0]?.trim();
  if (!host) return null;
  const forwardedProto = (headers['x-forwarded-proto'] || '').split(',')[0]?.trim().toLowerCase();
  const proto = forwardedProto || (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function cacheGeneratedImageDataUrl(dataUrl: string): string | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  let data: Buffer;
  try {
    data = Buffer.from(parsed.base64, 'base64');
  } catch {
    return null;
  }
  if (!data.length) return null;

  pruneGeneratedImageCapacity(data.length);
  const id = randomUUID();
  const now = Date.now();
  generatedImageStore.set(id, {
    mimeType: parsed.mimeType,
    data,
    createdAt: now,
    expiresAt: now + GENERATED_IMAGE_TTL_MS,
    size: data.length,
  });
  generatedImageStoreBytes += data.length;
  return `${GENERATED_IMAGE_ROUTE_PREFIX}/${id}`;
}

export function toPublicGeneratedImageReference(imageRef: string | undefined, headers?: Record<string, string>): string | undefined {
  if (typeof imageRef !== 'string' || !imageRef.trim()) return undefined;
  const trimmed = imageRef.trim();
  if (!trimmed.startsWith('data:image/')) return trimmed;
  const cachedPath = cacheGeneratedImageDataUrl(trimmed);
  if (!cachedPath) return trimmed;
  const origin = resolvePublicOrigin(headers);
  return origin ? `${origin}${cachedPath}` : cachedPath;
}

export function formatGeneratedImageMarkdown(imageRef: string | undefined, headers?: Record<string, string>, altText: string = 'generated image'): string {
  const publicRef = toPublicGeneratedImageReference(imageRef, headers);
  if (!publicRef) return '';
  return `![${altText}](${publicRef})`;
}

export function rewriteGeneratedImageContent(raw: string, headers?: Record<string, string>): string {
  if (typeof raw !== 'string' || !raw) return '';

  if (raw.startsWith('data:image/')) {
    return formatGeneratedImageMarkdown(raw, headers);
  }

  return raw.replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/gi, (_match, altText: string, dataUrl: string) => {
    const publicRef = toPublicGeneratedImageReference(dataUrl, headers) || dataUrl;
    return `![${altText || 'generated image'}](${publicRef})`;
  });
}

export function getCachedGeneratedImage(imageId: string): { mimeType: string; data: Buffer } | null {
  pruneExpiredGeneratedImages();
  const asset = generatedImageStore.get(String(imageId || '').trim());
  if (!asset) return null;
  if (asset.expiresAt <= Date.now()) {
    evictGeneratedImage(String(imageId || '').trim());
    return null;
  }
  return { mimeType: asset.mimeType, data: asset.data };
}

export function getGeneratedImageCacheControlHeader(): string {
  return `public, max-age=${Math.max(60, Math.floor(GENERATED_IMAGE_TTL_MS / 1000))}, immutable`;
}
