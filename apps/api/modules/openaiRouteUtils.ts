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

export function inferToolCallsFromJsonText(raw: string, tools: any[] | undefined, toolChoice?: any): any[] | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const parsedCandidates = collectJsonObjectCandidates(raw);
  if (parsedCandidates.length === 0) return undefined;

  const requestedToolName = typeof toolChoice === 'object' && toolChoice
    ? (toolChoice?.function?.name || toolChoice?.name)
    : undefined;
  const availableToolNames = tools
    .map((tool) => {
      const fn = tool?.function;
      return typeof fn?.name === 'string' ? fn.name : (typeof tool?.name === 'string' ? tool.name : undefined);
    })
    .filter((name): name is string => Boolean(name));

  const directToolCalls = ((): any[] | undefined => {
    for (const parsed of parsedCandidates) {
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        const normalized = parsed.tool_calls
          .map((call: any) => {
            const name = call?.function?.name ?? call?.name ?? call?.tool_name;
            const argumentsPayload = call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? call?.args;
            if (typeof name !== 'string' || !name.trim()) return null;
            if (requestedToolName && name !== requestedToolName) return null;
            return buildInferredToolCall(name, argumentsPayload);
          })
          .filter(Boolean);
        if (normalized.length > 0) return normalized;
      }

      const wrappedName = parsed?.function?.name ?? parsed?.name ?? parsed?.tool_name ?? parsed?.tool;
      const wrappedArguments = parsed?.function?.arguments ?? parsed?.arguments ?? parsed?.parameters ?? parsed?.args;
      if (typeof wrappedName === 'string' && wrappedName.trim()) {
        if (!requestedToolName || wrappedName === requestedToolName) {
          return [buildInferredToolCall(wrappedName, wrappedArguments)];
        }
      }

      if (requestedToolName && parsed[requestedToolName] && typeof parsed[requestedToolName] === 'object' && !Array.isArray(parsed[requestedToolName])) {
        return [buildInferredToolCall(requestedToolName, parsed[requestedToolName])];
      }

      if (availableToolNames.length === 1) {
        const soleToolName = availableToolNames[0];
        const commonArgsPayload = parsed?.arguments ?? parsed?.parameters ?? parsed?.args;
        if (commonArgsPayload && typeof commonArgsPayload === 'object' && !Array.isArray(commonArgsPayload)) {
          return [buildInferredToolCall(soleToolName, commonArgsPayload)];
        }
      }
    }

    return undefined;
  })();

  if (directToolCalls && directToolCalls.length > 0) return directToolCalls;

  let bestMatch: { name: string; score: number; parsed: Record<string, any> } | undefined;

  for (const parsed of parsedCandidates) {
    const keys = Object.keys(parsed);
    for (const tool of tools) {
      const fn = tool?.function;
      const name = typeof fn?.name === 'string' ? fn.name : (typeof tool?.name === 'string' ? tool.name : undefined);
      const params = fn?.parameters || tool?.parameters;
      if (!name) continue;
      if (requestedToolName && name !== requestedToolName) continue;

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

      if (required.length > 0 && missingRequired > 0) continue;
      if (properties.length > 0 && matchedProperties === 0) continue;

      const score = (matchedRequired * 100) + (matchedProperties * 10) - unexpectedKeys;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { name, score, parsed };
      }
    }
  }

  if (!bestMatch) return undefined;

  return [buildInferredToolCall(bestMatch.name, bestMatch.parsed)];
}

export function filterValidChatMessages(rawMessages: any): { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string }[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages.filter((msg) => msg && typeof msg.role === 'string');
}
