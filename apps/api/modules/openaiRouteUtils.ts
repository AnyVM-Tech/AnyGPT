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

export function formatReasoningBlock(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/<\s*think\b/i.test(trimmed)) return trimmed;
  return `<think>${trimmed}</think>`;
}

export function composeAssistantContent(rawResponse: string, rawReasoning?: string): string {
  const response = formatAssistantContent(rawResponse);
  const reasoningBlock = formatReasoningBlock(rawReasoning);
  if (!reasoningBlock) return response;
  if (!response) return reasoningBlock;
  return `${reasoningBlock}\n\n${response}`;
}

function parseJsonObjectCandidate(raw: string): Record<string, any> | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    // Ignore malformed candidate blocks.
  }

  return undefined;
}

function collectJsonObjectCandidates(raw: string): Record<string, any>[] {
  const source = String(raw || '').trim();
  if (!source) return [];

  const candidates: Record<string, any>[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string) => {
    const parsed = parseJsonObjectCandidate(value);
    if (!parsed) return;
    const signature = JSON.stringify(parsed);
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(parsed);
  };

  pushCandidate(source);

  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (typeof match[1] === 'string') pushCandidate(match[1]);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char !== '}') continue;

    depth -= 1;
    if (depth === 0) {
      pushCandidate(source.slice(start, index + 1));
      start = -1;
    }
  }

  return candidates;
}

function serializeToolArguments(rawArguments: any): string {
  if (typeof rawArguments === 'string') return rawArguments;
  if (typeof rawArguments === 'undefined') return '{}';
  try {
    return JSON.stringify(rawArguments);
  } catch {
    return String(rawArguments ?? '{}');
  }
}

function buildInferredToolCall(name: string, rawArguments: any): any {
  return {
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: {
      name,
      arguments: serializeToolArguments(rawArguments),
    },
  };
}

function collectInferableToolNames(tools: any[] | undefined): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return undefined;

      const toolType = typeof tool.type === 'string' ? tool.type.trim().toLowerCase() : '';
      const isFunctionTool = Boolean(tool?.function && typeof tool.function === 'object')
        || !toolType
        || toolType === 'function';
      if (!isFunctionTool) return undefined;

      const name = typeof tool?.function?.name === 'string'
        ? tool.function.name
        : (typeof tool?.name === 'string' ? tool.name : undefined);
      const trimmed = typeof name === 'string' ? name.trim() : '';
      return trimmed || undefined;
    })
    .filter((name): name is string => Boolean(name));
}

export function inferToolCallsFromJsonText(raw: string, tools: any[] | undefined, toolChoice?: any): any[] | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const parsedCandidates = collectJsonObjectCandidates(raw);
  if (parsedCandidates.length === 0) return undefined;

  const requestedToolName = typeof toolChoice === 'object' && toolChoice
    ? (toolChoice?.function?.name || toolChoice?.name)
    : undefined;
  const availableToolNames = collectInferableToolNames(tools);
  if (availableToolNames.length === 0) return undefined;
  const availableToolNameSet = new Set(availableToolNames);

  const normalizeExplicitToolCall = (rawName: unknown, rawArguments: any): any | null => {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return null;
    if (!availableToolNameSet.has(name)) return null;
    if (requestedToolName && name !== requestedToolName) return null;
    return buildInferredToolCall(name, rawArguments);
  };

  // Keep inference intentionally strict. Broad schema matching caused plain assistant
  // JSON output to be mistaken for a new tool call, which can loop client-side tools.
  for (const parsed of parsedCandidates) {
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const normalized = parsed.tool_calls
        .map((call: any) => normalizeExplicitToolCall(
          call?.function?.name ?? call?.name ?? call?.tool_name,
          call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? call?.args,
        ))
        .filter(Boolean);
      if (normalized.length > 0) return normalized;
    }

    const wrappedCall = normalizeExplicitToolCall(
      parsed?.function?.name ?? parsed?.name ?? parsed?.tool_name ?? parsed?.tool,
      parsed?.function?.arguments ?? parsed?.arguments ?? parsed?.parameters ?? parsed?.args,
    );
    if (wrappedCall) return [wrappedCall];
  }

  return undefined;
}

export function filterValidChatMessages(rawMessages: any): { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages.filter((msg) => msg && typeof msg.role === 'string');
}
