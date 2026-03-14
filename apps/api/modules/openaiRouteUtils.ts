export function isImageModelId(modelId: string): boolean {
  const normalized = String(modelId || '').toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('embedding') || normalized.includes('transcribe')) return false;
  return normalized.includes('imagen') || normalized.includes('image') || normalized.includes('nano-banana');
}

export function isNanoBananaModel(modelId: string): boolean {
  const normalized = String(modelId || '').toLowerCase();
  return normalized.includes('nano-banana');
}

export function ensureNanoBananaModalities(modalities: any): string[] {
  const raw = Array.isArray(modalities) ? modalities : [];
  const normalized = raw.map((m) => String(m).toLowerCase().trim()).filter(Boolean);
  const set = new Set<string>(normalized);
  set.add('image');
  set.add('text');
  return Array.from(set);
}

export function isNonChatModel(modelId: string): 'tts' | 'stt' | 'image-gen' | 'video-gen' | 'embedding' | false {
  const n = String(modelId || '').toLowerCase();
  if (n.startsWith('tts-') || n.includes('-tts')) return 'tts';
  if (n.startsWith('whisper') || n.includes('transcribe')) return 'stt';
  if (n.includes('grok-imagine-video') || n.includes('imagine-video')) return 'video-gen';
  if (
    n.startsWith('dall-e') ||
    n.startsWith('gpt-image') ||
    n.includes('gpt-image') ||
    n.includes('chatgpt-image') ||
    n.includes('image-gen') ||
    n.includes('imagegen') ||
    n.startsWith('imagen') ||
    n.includes('imagen') ||
    n.includes('nano-banana') ||
    n.includes('grok-imagine') ||
    n.includes('grok-2-image')
  ) return 'image-gen';
  if (n.includes('embedding')) return 'embedding';
  return false;
}

export function formatAssistantContent(raw: string): string {
  if (typeof raw !== 'string') return '';
  if (raw.startsWith('data:image/')) {
    return `![generated image](${raw})`;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        if (entries.length === 1) {
          const [onlyKey, onlyValue] = entries[0];
          if (typeof onlyValue === 'string' && ['result', 'content', 'message', 'text'].includes(onlyKey)) {
            return onlyValue;
          }
          if (onlyValue && typeof onlyValue === 'object' && !Array.isArray(onlyValue)) {
            const nestedText = (onlyValue as any).text ?? (onlyValue as any).content ?? (onlyValue as any).message;
            if (typeof nestedText === 'string' && ['result', 'content', 'message', 'text'].includes(onlyKey)) {
              return nestedText;
            }
          }
        }
      }
    } catch {
      // Leave non-JSON or intentionally-JSON output unchanged.
    }
  }
  return raw;
}

export function inferToolCallsFromJsonText(raw: string, tools: any[] | undefined, toolChoice?: any): any[] | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const requestedToolName = typeof toolChoice === 'object' && toolChoice
    ? (toolChoice?.function?.name || toolChoice?.name)
    : undefined;

  const keys = Object.keys(parsed);
  const candidates = tools
    .map((tool) => {
      const fn = tool?.function;
      const name = typeof fn?.name === 'string' ? fn.name : (typeof tool?.name === 'string' ? tool.name : undefined);
      const params = fn?.parameters || tool?.parameters;
      if (!name) return null;
      if (requestedToolName && name !== requestedToolName) return null;

      const properties = params && typeof params === 'object' && params.properties && typeof params.properties === 'object'
        ? Object.keys(params.properties)
        : [];
      const required = params && typeof params === 'object' && Array.isArray(params.required)
        ? params.required.filter((key: any) => typeof key === 'string')
        : [];

      const matchedRequired = required.filter((key: string) => keys.includes(key)).length;
      const missingRequired = required.length - matchedRequired;
      const matchedProperties = properties.filter((key: string) => keys.includes(key)).length;
      const unexpectedKeys = properties.length > 0
        ? keys.filter((key) => !properties.includes(key)).length
        : 0;

      if (required.length > 0 && missingRequired > 0) return null;
      if (properties.length > 0 && matchedProperties === 0) return null;

      const score = (matchedRequired * 100) + (matchedProperties * 10) - unexpectedKeys;
      return { name, score };
    })
    .filter((candidate): candidate is { name: string; score: number } => Boolean(candidate))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return undefined;

  return [{
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: {
      name: best.name,
      arguments: JSON.stringify(parsed),
    },
  }];
}

export function filterValidChatMessages(rawMessages: any): { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages.filter((msg) => msg && typeof msg.role === 'string');
}
