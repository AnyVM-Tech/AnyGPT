import type { VideoRequestCacheProvider } from './geminiVideo.js';

const MIN_VIDEO_REQUEST_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_VIDEO_REQUEST_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function normalizePositiveInteger(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return null;
}

export function resolveVideoRequestCacheTtlMs(
	configuredTtlMs?: unknown
): number {
	const normalized = normalizePositiveInteger(configuredTtlMs);
	return Math.max(
		MIN_VIDEO_REQUEST_CACHE_TTL_MS,
		normalized ?? DEFAULT_VIDEO_REQUEST_CACHE_TTL_MS
	);
}

export function buildVideoRequestCacheProvider(
	provider: VideoRequestCacheProvider,
	payload?: unknown,
	fallbackTtlMs: number = resolveVideoRequestCacheTtlMs()
): VideoRequestCacheProvider {
	const baseTtlMs =
		normalizePositiveInteger(provider.ttlMs) ??
		resolveVideoRequestCacheTtlMs(fallbackTtlMs);

	const normalized: VideoRequestCacheProvider = {
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		...(provider.kind ? { kind: provider.kind } : {}),
		...(provider.operationName
			? { operationName: provider.operationName }
			: {}),
		...(provider.modelId ? { modelId: provider.modelId } : {}),
		...(provider.contentUri ? { contentUri: provider.contentUri } : {}),
		...(provider.activeRequestId
			? { activeRequestId: provider.activeRequestId }
			: {}),
		...(provider.retryState ? { retryState: provider.retryState } : {}),
		ttlMs: baseTtlMs
	};

	if (!payload || typeof payload !== 'object') {
		return normalized;
	}

	const expiresAtSeconds = normalizePositiveInteger(
		(payload as Record<string, unknown>).expires_at
	);
	if (!expiresAtSeconds) {
		return normalized;
	}

	const timeUntilExpiryMs = (expiresAtSeconds * 1000) - Date.now();
	if (!Number.isFinite(timeUntilExpiryMs) || timeUntilExpiryMs <= 0) {
		return normalized;
	}

	return {
		...normalized,
		ttlMs: Math.max(baseTtlMs, Math.floor(timeUntilExpiryMs))
	};
}
