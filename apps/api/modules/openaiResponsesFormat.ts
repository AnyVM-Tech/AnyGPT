import crypto from 'node:crypto';

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

function createRandomId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
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

function buildResponsesFunctionCallItem(rawCall: any, status: string): Record<string, any> | null {
  if (!rawCall || typeof rawCall !== 'object') return null;

  const functionPayload = rawCall?.function && typeof rawCall.function === 'object'
    ? rawCall.function
    : rawCall;
  const name = typeof functionPayload?.name === 'string' && functionPayload.name.trim()
    ? functionPayload.name.trim()
    : (typeof rawCall?.name === 'string' && rawCall.name.trim() ? rawCall.name.trim() : undefined);
  if (!name) return null;

  const id = typeof rawCall?.id === 'string' && rawCall.id.trim()
    ? rawCall.id.trim()
    : createRandomId('fc');
  const callId = typeof rawCall?.call_id === 'string' && rawCall.call_id.trim()
    ? rawCall.call_id.trim()
    : (typeof rawCall?.tool_call_id === 'string' && rawCall.tool_call_id.trim()
      ? rawCall.tool_call_id.trim()
      : id);

  return {
    id,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: serializeToolArguments(functionPayload?.arguments ?? rawCall?.arguments),
    status,
  };
}

export function createResponsesItemId(prefix: 'msg' | 'resp' | 'evt' | 'fc' = 'msg'): string {
  return createRandomId(prefix);
}

export function createResponsesMessageItem(text: string, options: { id?: string; status?: string } = {}): Record<string, any> {
  return {
    id: options.id || createRandomId('msg'),
    type: 'message',
    role: 'assistant',
    status: options.status || 'completed',
    content: [{ type: 'output_text', text: text || '' }],
  };
}

export function buildResponsesOutputItems(
  outputText: string,
  toolCalls?: any[],
  options: { messageId?: string; messageStatus?: string; functionCallStatus?: string } = {},
): any[] {
  const items: any[] = [];
  const normalizedText = typeof outputText === 'string' ? outputText : '';
  const normalizedToolCalls = Array.isArray(toolCalls)
    ? toolCalls
      .map((call: any) => buildResponsesFunctionCallItem(call, options.functionCallStatus || 'completed'))
      .filter(Boolean)
    : [];

  items.push(createResponsesMessageItem(normalizedText, {
    id: options.messageId,
    status: options.messageStatus || 'completed',
  }));

  if (normalizedToolCalls.length > 0) items.push(...normalizedToolCalls);
  return items;
}

export function buildResponsesUsage(usage?: ResponsesUsage): Record<string, number> {
  const inputTokens = typeof usage?.input_tokens === 'number'
    ? usage.input_tokens
    : (typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined);
  const outputTokens = typeof usage?.output_tokens === 'number'
    ? usage.output_tokens
    : (typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined);
  const totalTokens = typeof usage?.total_tokens === 'number'
    ? usage.total_tokens
    : ((typeof inputTokens === 'number' || typeof outputTokens === 'number')
      ? (inputTokens || 0) + (outputTokens || 0)
      : undefined);

  return {
    ...(typeof inputTokens === 'number' ? { input_tokens: inputTokens } : {}),
    ...(typeof outputTokens === 'number' ? { output_tokens: outputTokens } : {}),
    ...(typeof totalTokens === 'number' ? { total_tokens: totalTokens } : {}),
  };
}

export function buildResponsesResponseObject(params: {
  id: string;
  created: number;
  model: string;
  outputText: string;
  toolCalls?: any[];
  status?: string;
  messageId?: string;
  messageStatus?: string;
  functionCallStatus?: string;
  usage?: ResponsesUsage;
}): Record<string, any> {
  const usage = buildResponsesUsage(params.usage);
  return {
    id: params.id,
    object: 'response',
    created: params.created,
    model: params.model,
    status: params.status || 'completed',
    output: buildResponsesOutputItems(params.outputText, params.toolCalls, {
      messageId: params.messageId,
      messageStatus: params.messageStatus,
      functionCallStatus: params.functionCallStatus,
    }),
    output_text: params.outputText,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function createEvent(type: string, payload: Record<string, any>): Record<string, any> {
  return {
    event_id: createRandomId('evt'),
    type,
    ...payload,
  };
}

export function buildResponsesCreatedEvent(responseBody: Record<string, any>): Record<string, any> {
  return createEvent('response.created', { response: responseBody });
}

export function buildResponsesCompletedEvent(responseBody: Record<string, any>): Record<string, any> {
  return createEvent('response.completed', { response: responseBody });
}

export function buildResponsesOutputItemAddedEvent(params: {
  responseId: string;
  outputIndex?: number;
  item: Record<string, any>;
}): Record<string, any> {
  return createEvent('response.output_item.added', {
    response_id: params.responseId,
    output_index: params.outputIndex ?? 0,
    item: params.item,
  });
}

export function buildResponsesOutputItemDoneEvent(params: {
  responseId: string;
  outputIndex?: number;
  item: Record<string, any>;
}): Record<string, any> {
  return createEvent('response.output_item.done', {
    response_id: params.responseId,
    output_index: params.outputIndex ?? 0,
    item: params.item,
  });
}

export function buildResponsesContentPartAddedEvent(params: {
  responseId: string;
  itemId: string;
  outputIndex?: number;
  contentIndex?: number;
  part: Record<string, any>;
}): Record<string, any> {
  return createEvent('response.content_part.added', {
    response_id: params.responseId,
    item_id: params.itemId,
    output_index: params.outputIndex ?? 0,
    content_index: params.contentIndex ?? 0,
    part: params.part,
  });
}

export function buildResponsesContentPartDoneEvent(params: {
  responseId: string;
  itemId: string;
  outputIndex?: number;
  contentIndex?: number;
  part: Record<string, any>;
}): Record<string, any> {
  return createEvent('response.content_part.done', {
    response_id: params.responseId,
    item_id: params.itemId,
    output_index: params.outputIndex ?? 0,
    content_index: params.contentIndex ?? 0,
    part: params.part,
  });
}

export function buildResponsesOutputTextDeltaEvent(params: {
  responseId: string;
  itemId: string;
  outputIndex?: number;
  contentIndex?: number;
  delta: string;
}): Record<string, any> {
  return createEvent('response.output_text.delta', {
    response_id: params.responseId,
    item_id: params.itemId,
    output_index: params.outputIndex ?? 0,
    content_index: params.contentIndex ?? 0,
    delta: params.delta,
  });
}

export function buildResponsesOutputTextDoneEvent(params: {
  responseId: string;
  itemId: string;
  outputIndex?: number;
  contentIndex?: number;
  text: string;
}): Record<string, any> {
  return createEvent('response.output_text.done', {
    response_id: params.responseId,
    item_id: params.itemId,
    output_index: params.outputIndex ?? 0,
    content_index: params.contentIndex ?? 0,
    text: params.text,
  });
}

export function buildResponsesFunctionCallArgumentsDoneEvent(params: {
  responseId: string;
  itemId: string;
  outputIndex?: number;
  callId?: string;
  name?: string;
  argumentsText?: string;
}): Record<string, any> {
  return createEvent('response.function_call_arguments.done', {
    response_id: params.responseId,
    item_id: params.itemId,
    output_index: params.outputIndex ?? 0,
    ...(typeof params.callId === 'string' ? { call_id: params.callId } : {}),
    ...(typeof params.name === 'string' ? { name: params.name } : {}),
    arguments: typeof params.argumentsText === 'string' ? params.argumentsText : '{}',
  });
}
