type FetchOptions = RequestInit;

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getUpstreamTimeoutMs(): number {
  return readEnvNumber('UPSTREAM_TIMEOUT_MS', 120_000);
}

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal | null) {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;

  const abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  };

  const onExternalAbort = () => abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) {
      abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {},
  timeoutMs: number = getUpstreamTimeoutMs()
): Promise<Response> {
  const { signal: externalSignal, ...rest } = options;
  const { signal, cleanup } = createTimeoutSignal(timeoutMs, externalSignal);
  try {
    return await fetch(url, { ...rest, signal });
  } finally {
    cleanup();
  }
}
