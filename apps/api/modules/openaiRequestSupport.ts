export function getHeaderValue(headers: Record<string, any>, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(direct)) return typeof direct[0] === 'string' ? direct[0] : undefined;
  return typeof direct === 'string' ? direct : undefined;
}

export function normalizeImageFetchReferer(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractUsageTokens(usage: any): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
  if (!usage || typeof usage !== 'object') return {};

  const promptTokens = typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : (typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined);
  const completionTokens = typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : (typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined);
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;

  return { promptTokens, completionTokens, totalTokens };
}

export function createSseDataParser(onData: (data: string, eventName?: string) => void) {
  let buffer = '';
  let currentEvent = '';

  return (chunk: string) => {
    buffer += chunk;

    while (true) {
      const lineBreakIndex = buffer.indexOf('\n');
      if (lineBreakIndex === -1) break;

      let line = buffer.slice(0, lineBreakIndex);
      buffer = buffer.slice(lineBreakIndex + 1);

      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (!line) {
        currentEvent = '';
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        onData(line.slice(5).trimStart(), currentEvent || undefined);
      }
    }
  };
}
