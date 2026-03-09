import axios from 'axios';
import {
  IAIProvider,
  IMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderStreamPassthrough,
  ProviderUsage
} from './interfaces.js'; // Only import necessary interfaces

const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export class OpenAI implements IAIProvider {
    private isAudioModel(modelId: string): boolean {
      return this.normalizeModelId(modelId).includes('audio');
    }

    private isMissingMessagesError(error: any): boolean {
      const message = this.extractApiErrorMessage(error).toLowerCase();
      return message.includes("missing required parameter: 'messages'")
        || message.includes('missing required parameter: "messages"');
    }

    private isMissingInputError(error: any): boolean {
      const message = this.extractApiErrorMessage(error).toLowerCase();
      return message.includes("missing required parameter: 'input'")
        || message.includes('missing required parameter: "input"');
    }

    private extractApiErrorMessage(error: any): string {
      const data = error?.response?.data;
      const apiError = data?.error;
      if (typeof apiError === 'string') {
        const code = data?.code ? ` (code: ${data.code})` : '';
        return `${apiError}${code}`;
      }
      if (apiError && typeof apiError === 'object') {
        const message = apiError?.message || apiError?.error || data?.message || 'Unknown API error';
        const code = apiError?.code || data?.code;
        const type = apiError?.type;
        return `${message}${code ? ` (code: ${code})` : ''}${type ? ` [${type}]` : ''}`;
      }
      if (typeof data?.message === 'string' && data.message) {
        const code = data?.code ? ` (code: ${data.code})` : '';
        return `${data.message}${code}`;
      }
      return error?.message || 'Unknown API error';
    }

  private normalizeUnsupportedParamName(raw: string): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const unquoted = trimmed.replace(/^['"`]+|['"`]+$/g, '');
    const base = unquoted.split(/[.\[]/)[0]?.trim();
    if (!base) return null;
    return base.toLowerCase();
  }

  private getUnsupportedParamSet(modelId: string): Set<string> {
    const key = this.normalizeModelId(modelId);
    let set = this.unsupportedParamsByModel.get(key);
    if (!set) {
      set = new Set<string>();
      this.unsupportedParamsByModel.set(key, set);
    }
    return set;
  }

  private recordUnsupportedParams(modelId: string, params: string[]): string[] {
    const set = this.getUnsupportedParamSet(modelId);
    const added: string[] = [];
    for (const param of params) {
      const normalized = this.normalizeUnsupportedParamName(param);
      if (!normalized) continue;
      if (!set.has(normalized)) {
        set.add(normalized);
        added.push(normalized);
      }
    }
    return added;
  }

  private stripUnsupportedParamsFromPayload(
    payload: Record<string, any>,
    modelId: string,
    extraParams?: string[],
  ): { cleaned: Record<string, any>; removed: string[] } {
    const unsupported = new Set<string>(this.getUnsupportedParamSet(modelId));
    if (Array.isArray(extraParams)) {
      for (const param of extraParams) {
        const normalized = this.normalizeUnsupportedParamName(param);
        if (normalized) unsupported.add(normalized);
      }
    }

    if (unsupported.size === 0) {
      return { cleaned: payload, removed: [] };
    }

    const cleaned = { ...payload };
    const removed = new Set<string>();
    const protectedKeys = new Set(['model', 'messages', 'input', 'stream']);
    const removeKey = (key: string) => {
      if (Object.prototype.hasOwnProperty.call(cleaned, key)) {
        delete cleaned[key];
        removed.add(key);
      }
    };

    for (const key of Object.keys(cleaned)) {
      const normalizedKey = key.toLowerCase();
      if (protectedKeys.has(normalizedKey)) continue;
      if (unsupported.has(normalizedKey)) {
        removeKey(key);
      }
    }

    if (unsupported.has('max_tokens')) removeKey('max_output_tokens');
    if (unsupported.has('max_output_tokens')) removeKey('max_tokens');

    if (unsupported.has('tools') || unsupported.has('tool_choice')) {
      removeKey('tools');
      removeKey('tool_choice');
    }

    if (unsupported.has('audio') || unsupported.has('modalities')) {
      removeKey('audio');
      removeKey('modalities');
    }

    return { cleaned, removed: Array.from(removed) };
  }

  private extractUnsupportedParams(error: any): string[] {
    const results = new Set<string>();
    const paramField = error?.response?.data?.error?.param || error?.response?.data?.param;
    if (typeof paramField === 'string') {
      const normalized = this.normalizeUnsupportedParamName(paramField);
      if (normalized) results.add(normalized);
    }

    const message = this.extractApiErrorMessage(error);
    const patterns = [
      /Unsupported parameter:?\s*['"]([^'"]+)['"]/i,
      /Unrecognized request argument supplied:?\s*['"]?([^'"\s]+)['"]?/i,
      /Unknown parameter:?\s*['"]?([^'"\s]+)['"]?/i,
      /Invalid request.*?['"]([^'"]+)['"] is not supported/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        const normalized = this.normalizeUnsupportedParamName(match[1]);
        if (normalized) results.add(normalized);
      }
    }

    if (results.size === 0) {
      const listMatch = message.match(/Unsupported parameters?:\s*([^\.\[]+)/i);
      if (listMatch) {
        const entries = listMatch[1].split(',');
        for (const entry of entries) {
          const normalized = this.normalizeUnsupportedParamName(entry);
          if (normalized) results.add(normalized);
        }
      }
    }

    return Array.from(results);
  }

    private extractUsage(data: any, useResponsesApi: boolean): ProviderUsage | undefined {
      if (useResponsesApi) {
        const usage = data?.usage || data?.response?.usage;
        if (!usage) return undefined;
        const prompt_tokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined);
        const completion_tokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined);
        const total_tokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
        if (prompt_tokens === undefined && completion_tokens === undefined && total_tokens === undefined) return undefined;
        return { prompt_tokens, completion_tokens, total_tokens };
      }

      const usage = data?.usage;
      if (!usage) return undefined;
      const prompt_tokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
      const completion_tokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
      const total_tokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
      if (prompt_tokens === undefined && completion_tokens === undefined && total_tokens === undefined) return undefined;
      return { prompt_tokens, completion_tokens, total_tokens };
    }

  private apiKey: string;
  private endpointUrl: string;
  private hasCustomEndpoint: boolean;
  private unsupportedParamsByModel = new Map<string, Set<string>>();
  // Removed state properties: busy, lastLatency, providerData, alpha

  /**
   * Constructor for the OpenAI provider.
   * @param apiKey - The API key to use. If it starts with 'sk-', it's considered an OpenAI key.
   * @param endpointUrl - Optional custom endpoint URL. If provided, it replaces the default endpoint.
   */
  constructor(apiKey: string, endpointUrl?: string) {
    // Validate inputs
    if (!apiKey && !endpointUrl) {
      throw new Error('Either an OpenAI API key or an endpoint URL must be provided');
    }

    if (apiKey && apiKey.startsWith('sk-')) {
      this.apiKey = apiKey;
      this.endpointUrl = endpointUrl || OPENAI_CHAT_ENDPOINT;
    } else {
      this.apiKey = apiKey || '';
      if (endpointUrl) {
        this.endpointUrl = endpointUrl;
      } else {
        throw new Error('Endpoint URL must be provided if API key is not an OpenAI API key');
      }
    }
    this.hasCustomEndpoint = !!endpointUrl;
    // Removed providerData initialization
  }

  private normalizeModelId(modelId: string): string {
    const id = (modelId || '').toLowerCase();
    const slashIndex = id.indexOf('/') + 1;
    return slashIndex > 0 ? id.slice(slashIndex) : id;
  }

  private readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private getRequestTimeoutMs(): number {
    const upstreamTimeout = this.readEnvNumber('UPSTREAM_TIMEOUT_MS', 120_000);
    return this.readEnvNumber('OPENAI_TIMEOUT_MS', upstreamTimeout);
  }

  private isComputerUseModel(modelId: string): boolean {
    const normalized = this.normalizeModelId(modelId);
    return normalized.includes('computer-use');
  }

  private isResponsesOnlyModel(modelId: string): boolean {
    const normalized = this.normalizeModelId(modelId);
    return (
      normalized.startsWith('o3')
      || normalized.startsWith('o4')
      || normalized.includes('deep-research')
      || normalized.includes('computer-use')
    );
  }

  private supportsReasoningParam(modelId: string): boolean {
    const normalized = this.normalizeModelId(modelId);
    return (
      normalized.startsWith('o1')
      || normalized.startsWith('o3')
      || normalized.startsWith('o4')
      || normalized.includes('omni')
      || normalized.includes('deep-research')
      || normalized.includes('gpt-5')
    );
  }

  private isResponsesEndpoint(url: string): boolean {
    return url.includes('/v1/responses') || url.includes('/responses');
  }

  private shouldUseResponsesApi(modelId: string, force?: boolean): boolean {
    if (force) return true;
    const normalized = this.normalizeModelId(modelId);
    if (this.isComputerUseModel(normalized)) return true;
    if (normalized.includes('codex')) return true;
    // GPT-5-family models are Responses-first for reliable structured tool calling.
    if (normalized.includes('gpt-5')) return true;
    if (normalized.includes('gpt-4.1')) return true;
    if (normalized.includes('o3') || normalized.includes('omni')) return true;
    // Match specific "pro" model families (e.g. "o1-pro", "o3-pro") without
    // accidentally matching unrelated models that happen to contain "pro".
    if (/(?:^|[-_])pro(?:$|[-_])/.test(normalized)) return true;
    return false;
  }

  private resolveChatEndpoint(): string {
    if (this.hasCustomEndpoint) {
      const url = this.endpointUrl;
      if (url.includes('/responses')) return url.replace('/responses', '/chat/completions');
      if (url.endsWith('/v1')) return `${url}/chat/completions`;
      if (url.includes('/v1/')) {
        const idx = url.indexOf('/v1/');
        return `${url.slice(0, idx + 4)}chat/completions`;
      }
      return url;
    }

    return OPENAI_CHAT_ENDPOINT;
  }

  private resolveResponsesEndpoint(): string {
    if (this.hasCustomEndpoint) {
      const url = this.endpointUrl;
      if (url.includes('/chat/completions')) return url.replace('/chat/completions', '/responses');
      if (url.endsWith('/v1')) return `${url}/responses`;
      if (url.includes('/v1/')) {
        const idx = url.indexOf('/v1/');
        return `${url.slice(0, idx + 4)}responses`;
      }
      return url;
    }

    return OPENAI_RESPONSES_ENDPOINT;
  }

  private resolveEndpoint(modelId: string, forceResponses?: boolean): string {
    const wantsResponses = this.shouldUseResponsesApi(modelId, forceResponses);
    return wantsResponses ? this.resolveResponsesEndpoint() : this.resolveChatEndpoint();
  }

  private normalizeContent(val: any): string {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      for (const part of val) {
        if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
      }
    }
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  }

  private normalizeChatContent(content: any): any {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const type = String((part as any).type || '').toLowerCase();
      if (type === 'input_text') {
        return { type: 'text', text: (part as any).text ?? '' };
      }
      if (type === 'input_image' && (part as any).image_url) {
        return { type: 'image_url', image_url: (part as any).image_url };
      }
      return part;
    });
  }

  private normalizeChatMessages(message: IMessage) {
    const source = Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : [{
          role: message.role || 'user',
          content: message.content,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? { tool_calls: message.tool_calls } : {}),
          ...(typeof message.tool_call_id === 'string' && message.tool_call_id.trim() ? { tool_call_id: message.tool_call_id.trim() } : {}),
          ...(typeof message.name === 'string' && message.name.trim() ? { name: message.name.trim() } : {}),
        }];

    return source.map((entry) => {
      const rawRole = typeof entry.role === 'string' ? entry.role.trim() : '';
      const role = rawRole || 'user';
      const normalized: Record<string, any> = {
        role,
        content: this.normalizeChatContent(entry.content),
      };
      if (Array.isArray((entry as any).tool_calls) && (entry as any).tool_calls.length > 0) {
        normalized.tool_calls = (entry as any).tool_calls;
      }
      if (typeof (entry as any).tool_call_id === 'string' && (entry as any).tool_call_id.trim()) {
        normalized.tool_call_id = (entry as any).tool_call_id.trim();
      }
      if (typeof (entry as any).name === 'string' && (entry as any).name.trim()) {
        normalized.name = (entry as any).name.trim();
      }
      return normalized;
    });
  }

  private buildChatStreamOptions(message: IMessage): Record<string, any> | undefined {
    const existing = message.stream_options && typeof message.stream_options === 'object'
      ? { ...message.stream_options }
      : {};

    if (this.hasCustomEndpoint && Object.prototype.hasOwnProperty.call(existing, 'include_usage')) {
      delete (existing as any).include_usage;
    }

    return Object.keys(existing).length > 0 ? existing : undefined;
  }

  private buildResponsesStreamOptions(message: IMessage): Record<string, any> | undefined {
    const existing = message.stream_options && typeof message.stream_options === 'object'
      ? { ...message.stream_options }
      : {};
    if (Object.prototype.hasOwnProperty.call(existing, 'include_usage')) {
      delete (existing as any).include_usage;
    }
    return Object.keys(existing).length > 0 ? existing : undefined;
  }

  private attachChatOptionalParams(target: Record<string, any>, message: IMessage) {
    if (message.system) target.system = message.system;
    if (message.response_format) target.response_format = message.response_format;
    if (typeof message.max_tokens === 'number') target.max_tokens = message.max_tokens;
    if (typeof message.temperature === 'number') target.temperature = message.temperature;
    if (typeof message.top_p === 'number') target.top_p = message.top_p;
    if (message.metadata) target.metadata = message.metadata;
    if (typeof message.tools !== 'undefined') {
      target.tools = this.normalizeChatTools(message.tools) ?? message.tools;
    }
    if (typeof message.tool_choice !== 'undefined') {
      target.tool_choice = this.normalizeChatToolChoice(message.tool_choice);
    }
    if (typeof message.reasoning !== 'undefined' && this.supportsReasoningParam(message.model.id)) {
      target.reasoning = message.reasoning;
    }
    if (typeof message.service_tier === 'string' && message.service_tier.trim()) {
      target.service_tier = message.service_tier.trim();
    }

    const hasAudioInput = this.hasAudioInputContent(message.content);
    const hasAudioModality = Array.isArray(message.modalities) && message.modalities.some((modality) => String(modality).toLowerCase() === 'audio');
    if (this.isAudioModel(message.model.id) && !hasAudioInput && !hasAudioModality) {
      target.modalities = ['text', 'audio'];
      target.audio = message.audio || { voice: 'alloy', format: 'wav' };
    } else {
      if (message.modalities) target.modalities = message.modalities;
      if (message.audio) target.audio = message.audio;
    }

    return target;
  }

  private normalizeChatTools(tools: any): any[] | undefined {
    if (!Array.isArray(tools)) return undefined;
    return tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      const func = (tool as any).function;
      if (func && typeof func === 'object') {
        return tool;
      }
      const name = (tool as any).name;
      const description = (tool as any).description;
      const parameters = (tool as any).parameters;
      if (!name) return tool;
      const normalized: Record<string, any> = {
        type: (tool as any).type ?? 'function',
        function: {
          name,
        },
      };
      if (description) normalized.function.description = description;
      if (parameters) normalized.function.parameters = parameters;
      if (typeof (tool as any).strict !== 'undefined') {
        normalized.function.strict = (tool as any).strict;
      }
      return normalized;
    });
  }

  private normalizeChatToolChoice(toolChoice: any): any {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    if (Array.isArray(toolChoice)) return toolChoice;
    const func = (toolChoice as any).function;
    if (func && typeof func === 'object') return toolChoice;
    const name = (toolChoice as any).name;
    if (name) {
      return { type: (toolChoice as any).type ?? 'function', function: { name } };
    }
    return toolChoice;
  }

  private normalizeResponsesTools(tools: any): any[] | undefined {
    if (!Array.isArray(tools)) return undefined;
    return tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      const func = (tool as any).function;
      if (func && typeof func === 'object') {
        const name = func.name ?? (tool as any).name;
        const description = func.description ?? (tool as any).description;
        const parameters = func.parameters ?? (tool as any).parameters;
        const normalized: Record<string, any> = {
          type: (tool as any).type ?? 'function',
        };
        if (name) normalized.name = name;
        if (description) normalized.description = description;
        if (parameters) normalized.parameters = parameters;
        if (typeof (tool as any).strict !== 'undefined') normalized.strict = (tool as any).strict;
        if (typeof (func as any).strict !== 'undefined' && typeof normalized.strict === 'undefined') {
          normalized.strict = (func as any).strict;
        }
        return normalized;
      }
      return tool;
    });
  }

  private normalizeResponsesToolChoice(toolChoice: any): any {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    if (Array.isArray(toolChoice)) return toolChoice;
    const func = (toolChoice as any).function;
    if (func && typeof func === 'object') {
      const name = func.name ?? (toolChoice as any).name;
      if (name) return { type: (toolChoice as any).type ?? 'function', name };
      return { type: (toolChoice as any).type ?? 'function' };
    }
    return toolChoice;
  }

  private hasAudioInputContent(content: IMessage['content']): boolean {
    if (!Array.isArray(content)) return false;

    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String((part as any).type || '').toLowerCase();
      if (type === 'input_audio') return true;
      if (type === 'audio' && (part as any).audio) return true;
      if ((part as any).input_audio && typeof (part as any).input_audio?.data === 'string') return true;
    }

    return false;
  }

  private attachResponsesOptionalParams(target: Record<string, any>, message: IMessage) {
    if (typeof message.max_output_tokens === 'number') target.max_output_tokens = message.max_output_tokens;
    if (typeof message.max_tokens === 'number' && typeof message.max_output_tokens !== 'number') target.max_output_tokens = message.max_tokens;
    if (typeof message.temperature === 'number') target.temperature = message.temperature;
    if (typeof message.top_p === 'number') target.top_p = message.top_p;
    if (message.metadata) target.metadata = message.metadata;
    if (typeof message.tools !== 'undefined') {
      target.tools = this.normalizeResponsesTools(message.tools) ?? message.tools;
    }
    if (typeof message.tool_choice !== 'undefined') {
      target.tool_choice = this.normalizeResponsesToolChoice(message.tool_choice);
    }
    if (typeof message.reasoning !== 'undefined' && this.supportsReasoningParam(message.model.id)) {
      if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
        target.reasoning = { effort: message.reasoning.trim() };
      } else {
        target.reasoning = message.reasoning;
      }
    }
    if (typeof message.service_tier === 'string' && message.service_tier.trim()) {
      target.service_tier = message.service_tier.trim();
    }
    if (message.instructions) target.instructions = message.instructions;
    if (message.modalities) target.modalities = message.modalities;
    if (message.audio) target.audio = message.audio;
    if (this.isComputerUseModel(message.model.id) && typeof target.truncation === 'undefined') {
      target.truncation = 'auto';
    }
    return target;
  }

  private normalizeResponsesContentParts(content: any): any[] {
    const parts = Array.isArray(content) ? content : [content];
    const normalized: any[] = [];

    for (const part of parts) {
      if (typeof part === 'string') {
        normalized.push({ type: 'input_text', text: part });
        continue;
      }
      if (typeof part === 'number' || typeof part === 'boolean') {
        normalized.push({ type: 'input_text', text: String(part) });
        continue;
      }
      if (!part || typeof part !== 'object') {
        continue;
      }

      const type = String(part.type || '').toLowerCase();
      if (!type && typeof (part as any).text === 'string') {
        normalized.push({ type: 'input_text', text: (part as any).text });
        continue;
      }
      if ((type === 'text' || type === 'input_text') && typeof part.text === 'string') {
        normalized.push({ type: 'input_text', text: part.text });
        continue;
      }
      if (type === 'output_text') {
        const text = typeof (part as any).text === 'string'
          ? (part as any).text
          : (typeof (part as any).output_text === 'string' ? (part as any).output_text : undefined);
        if (typeof text === 'string') {
          normalized.push({ type: 'output_text', text });
        }
        continue;
      }

      if ((type === 'input_image' || type === 'image_url') && part.image_url) {
        if (typeof part.image_url === 'string') {
          normalized.push({ type: 'input_image', image_url: part.image_url });
        } else if (typeof part.image_url.url === 'string') {
          normalized.push({ type: 'input_image', image_url: part.image_url.url });
        }
        continue;
      }

      if (type === 'input_audio' && part.input_audio && typeof part.input_audio.data === 'string' && typeof part.input_audio.format === 'string') {
        normalized.push({ type: 'input_audio', input_audio: part.input_audio });
      }
    }

    return normalized;
  }

  private stringifyResponsesValue(value: any, fallback: string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'undefined') return fallback;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private normalizeResponsesSpecialInputItem(entry: any): any | null {
    if (!entry || typeof entry !== 'object') return null;

    const type = String(entry.type || '').toLowerCase();
    if (type === 'function_call_output') {
      const callId = typeof entry.call_id === 'string' && entry.call_id.trim()
        ? entry.call_id.trim()
        : undefined;
      if (!callId) return null;

      return {
        type: 'function_call_output',
        call_id: callId,
        output: this.stringifyResponsesValue(entry.output, ''),
      };
    }

    if (type === 'function_call') {
      const name = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : (typeof entry.function?.name === 'string' && entry.function.name.trim() ? entry.function.name.trim() : undefined);
      if (!name) return null;

      const normalized: Record<string, any> = {
        type: 'function_call',
        name,
        arguments: this.stringifyResponsesValue(
          entry.arguments ?? entry.function?.arguments ?? entry.args ?? entry.parameters,
          '{}',
        ),
      };

      if (typeof entry.id === 'string' && entry.id.trim()) normalized.id = entry.id.trim();
      if (typeof entry.call_id === 'string' && entry.call_id.trim()) normalized.call_id = entry.call_id.trim();
      if (typeof entry.status === 'string' && entry.status.trim()) normalized.status = entry.status.trim();

      return normalized;
    }

    return null;
  }

  private hasStatefulResponsesInputEntry(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return false;

    const type = String(entry.type || '').toLowerCase();
    if (type === 'function_call' || type === 'function_call_output') return true;

    const role = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
    if (role === 'assistant' || role === 'tool') return true;

    if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) return true;

    const content = Array.isArray(entry.content) ? entry.content : [];
    return content.some((part: any) => {
      if (!part || typeof part !== 'object') return false;
      const partType = String(part.type || '').toLowerCase();
      if (partType === 'function_call' || partType === 'function_call_output') return true;
      if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) return true;
      return false;
    });
  }

  private normalizeResponsesInput(rawInput: any): any[] {
    if (Array.isArray(rawInput) && rawInput.length > 0) {
      const normalizedItems: any[] = [];
      let bufferedUserContent: any[] = [];

      const flushBufferedUserContent = () => {
        if (bufferedUserContent.length === 0) return;
        normalizedItems.push({ role: 'user', content: bufferedUserContent });
        bufferedUserContent = [];
      };

      for (const entry of rawInput) {
        const role = entry && typeof entry === 'object' && typeof entry.role === 'string'
          ? entry.role.trim()
          : '';
        if (role) {
          flushBufferedUserContent();
          normalizedItems.push({
            ...entry,
            role,
            content: this.normalizeResponsesContentParts(entry.content),
          });
          continue;
        }

        const specialItem = this.normalizeResponsesSpecialInputItem(entry);
        if (specialItem) {
          flushBufferedUserContent();
          normalizedItems.push(specialItem);
          continue;
        }

        const normalizedParts = this.normalizeResponsesContentParts(entry);
        if (normalizedParts.length > 0) {
          bufferedUserContent.push(...normalizedParts);
        }
      }

      flushBufferedUserContent();
      if (normalizedItems.length > 0) return normalizedItems;
    }

    const normalizedContent = this.normalizeResponsesContentParts(rawInput);
    if (normalizedContent.length === 0) {
      return [{ role: 'user', content: [{ type: 'input_text', text: this.normalizeContent(rawInput) }] }];
    }

    return [{ role: 'user', content: normalizedContent }];
  }

  private summarizeResponsesPayload(data: Record<string, any>) {
    const keys = Object.keys(data || {}).sort();
    const input = data?.input;
    const inputArray = Array.isArray(input) ? input : [];
    const first = inputArray[0];
    const content = Array.isArray(first?.content) ? first.content : [];
    const firstType = content[0]?.type;

    return {
      keys,
      inputItems: inputArray.length,
      firstRole: typeof first?.role === 'string' ? first.role : null,
      contentItems: content.length,
      firstContentType: typeof firstType === 'string' ? firstType : null,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Creates a stateful SSE line consumer. Feed it raw chunks and it returns
   * parsed `data:` payloads (excluding the `data:` prefix).
   */
  private createSseConsumer(): (rawChunk: any) => string[] {
    let buffer = '';
    return (rawChunk: any): string[] => {
      const text = Buffer.isBuffer(rawChunk) ? rawChunk.toString('utf8') : String(rawChunk);
      buffer += text;
      const dataLines: string[] = [];
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data:')) continue;
        dataLines.push(line.slice(5).trimStart());
      }
      return dataLines;
    };
  }

  private async readStreamBody(stream: any, maxBytes: number = 65536): Promise<string> {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return '';
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > maxBytes) {
        const remain = Math.max(0, maxBytes - (size - chunk.length));
        if (remain > 0) chunks.push(chunk.subarray(0, remain));
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async postSseRequest(url: string, data: Record<string, any>, headers: Record<string, string>) {
    const timeoutMs = this.getRequestTimeoutMs();
    const response = await axios.post(url, data, {
      headers,
      responseType: 'stream',
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const raw = await this.readStreamBody(response.data);
      let message = `HTTP ${response.status}`;
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        const apiError = parsed?.error;
        if (apiError?.message) {
          const code = apiError?.code ? ` (code: ${apiError.code})` : '';
          const type = apiError?.type ? ` [${apiError.type}]` : '';
          message = `${apiError.message}${code}${type}`;
        } else if (raw) {
          message = raw;
        }
      } catch {
        if (raw) message = raw;
      }
      throw new Error(`API stream call failed: ${message}`);
    }

    return response;
  }

  private buildChatPayload(message: IMessage, stream: boolean) {
    const payload: Record<string, any> = {
      model: message.model.id,
      messages: this.normalizeChatMessages(message),
      ...(stream ? { stream: true } : {}),
    };
    if (stream) {
      const streamOptions = this.buildChatStreamOptions(message);
      if (streamOptions) payload.stream_options = streamOptions;
    }
    this.attachChatOptionalParams(payload, message);

    if (this.isAudioModel(message.model.id) && payload.audio && typeof payload.audio === 'object') {
      const requestedFormat = typeof payload.audio.format === 'string' ? payload.audio.format.toLowerCase() : '';
      if (stream) {
        if (requestedFormat !== 'pcm16') {
          payload.audio = { ...payload.audio, format: 'pcm16' };
        }
      } else if (!requestedFormat) {
        payload.audio = { ...payload.audio, format: 'wav' };
      }
    }

    return payload;
  }

  private buildResponsesPayload(message: IMessage, stream: boolean) {
    const inputSource = Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : message.content;
    const input = this.normalizeResponsesInput(inputSource);
    let normalizedInput = input.map((entry: any) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (!('role' in entry)) return entry;
      const role = entry.role === 'tool' ? 'assistant' : entry.role;
      const cleaned: Record<string, any> = { role, content: entry.content };
      if (typeof entry.name === 'string' && entry.name.trim()) {
        cleaned.name = entry.name.trim();
      }
      return cleaned;
    });
    const normalizedModelId = this.normalizeModelId(message.model.id);
    const isCodexModel = normalizedModelId.includes('codex');
    const codexSingleTurnEnv = process.env.CODEX_SINGLE_TURN_ONLY === '1';
    const responsesSingleTurnEnabled = process.env.RESPONSES_SINGLE_TURN_ONLY !== '0';
    const isResponsesSingleTurnModel =
      isCodexModel
      || normalizedModelId.includes('gpt-5')
      || normalizedModelId.includes('gpt-4.1');
    const hasToolDefinitions = Array.isArray(message.tools) && message.tools.length > 0;
    const hasToolChoice = typeof message.tool_choice !== 'undefined';
    const hasStatefulInput = Boolean(message.previous_response_id)
      || normalizedInput.some((entry: any) => this.hasStatefulResponsesInputEntry(entry));
    const canSafelyCollapseToSingleTurn = !hasToolDefinitions && !hasToolChoice && !hasStatefulInput;
    const userEntries = normalizedInput.filter(
      (entry: any) => entry && typeof entry === 'object' && entry.role === 'user'
    );
    const shouldCollapseToSingleTurn =
      canSafelyCollapseToSingleTurn
      && (
        (isCodexModel && codexSingleTurnEnv)
        || (responsesSingleTurnEnabled && isResponsesSingleTurnModel && userEntries.length > 1)
      );
    if (shouldCollapseToSingleTurn) {
      const systemEntries = normalizedInput.filter(
        (entry: any) => entry && typeof entry === 'object' && (entry.role === 'system' || entry.role === 'developer')
      );
      const lastUserEntry = userEntries[userEntries.length - 1];
      if (lastUserEntry) {
        normalizedInput = [...systemEntries, lastUserEntry];
      }
    }

    normalizedInput = normalizedInput.map((entry: any) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (entry.role !== 'assistant' || !Array.isArray(entry.content)) return entry;
      const content = entry.content.map((part: any) => {
        if (!part || typeof part !== 'object') return part;
        const type = String(part.type || '').toLowerCase();
        if ((type === 'input_text' || type === 'text') && typeof part.text === 'string') {
          return { type: 'output_text', text: part.text };
        }
        if (type === 'output_text' && typeof part.text === 'string') return part;
        if (type === 'output_text' && typeof (part as any).output_text === 'string') {
          return { type: 'output_text', text: (part as any).output_text };
        }
        return part;
      });
      return { ...entry, content };
    });

    const payload: Record<string, any> = {
      model: message.model.id,
      input: normalizedInput,
      ...(stream ? { stream: true } : {}),
    };
    if (stream) {
      const streamOptions = this.buildResponsesStreamOptions(message);
      if (streamOptions) payload.stream_options = streamOptions;
    }

    return this.attachResponsesOptionalParams(payload, message);
  }

  private normalizeMimeType(raw: any, kind: 'image' | 'audio', fallbackSubtype: string): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return `${kind}/${fallbackSubtype}`;
    if (value.includes('/')) return value;
    return `${kind}/${value}`;
  }

  private toDataUrl(data: string, mimeType: string): string {
    return `data:${mimeType};base64,${data}`;
  }

  private extractImageFromPart(part: any): string | null {
    if (!part || typeof part !== 'object') return null;

    const directUrl = part?.image_url?.url ?? part?.image_url ?? part?.url ?? part?.image?.url;
    if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;

    const imageObj = part?.image ?? part?.output_image ?? null;
    const b64 =
      part?.b64_json
      || part?.image_base64
      || part?.image_bytes
      || imageObj?.b64_json
      || imageObj?.data
      || imageObj?.base64;

    if (typeof b64 === 'string' && b64.length > 0) {
      const mimeRaw = part?.mime_type || part?.mimeType || part?.format || imageObj?.mime_type || imageObj?.mimeType || imageObj?.format;
      const mime = this.normalizeMimeType(mimeRaw, 'image', 'png');
      return this.toDataUrl(b64, mime);
    }

    const fallbackUrl = imageObj?.image_url?.url ?? imageObj?.url;
    if (typeof fallbackUrl === 'string' && fallbackUrl.length > 0) return fallbackUrl;

    return null;
  }

  private extractAudioFromPart(part: any): string | null {
    if (!part || typeof part !== 'object') return null;

    const audioObj = part?.audio ?? part?.output_audio ?? part?.audio_output ?? null;
    const data =
      audioObj?.data
      || audioObj?.b64_json
      || audioObj?.base64
      || part?.audio_data
      || part?.audio_base64;

    if (typeof data === 'string' && data.length > 0) {
      const mimeRaw = audioObj?.mime_type || audioObj?.mimeType || audioObj?.format || part?.mime_type || part?.mimeType || part?.format;
      const mime = this.normalizeMimeType(mimeRaw, 'audio', 'wav');
      return this.toDataUrl(data, mime);
    }

    const directUrl = audioObj?.url ?? audioObj?.audio_url?.url ?? part?.audio_url?.url ?? part?.audio_url;
    if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;

    return null;
  }

  private extractMediaFromParts(parts: any[]): string | null {
    if (!Array.isArray(parts) || parts.length === 0) return null;

    for (const part of parts) {
      const image = this.extractImageFromPart(part);
      if (image) return image;
      const audio = this.extractAudioFromPart(part);
      if (audio) return audio;
    }

    return null;
  }

  private extractMediaFromResponsesOutput(output: any): string | null {
    const list = Array.isArray(output) ? output : (output ? [output] : []);
    for (const entry of list) {
      const media = this.extractMediaFromParts(entry?.content);
      if (media) return media;
      const direct = this.extractImageFromPart(entry) || this.extractAudioFromPart(entry);
      if (direct) return direct;
    }
    return null;
  }

  private extractMediaFromChatMessage(message: any): string | null {
    if (!message || typeof message !== 'object') return null;

    const audio = this.extractAudioFromPart(message?.audio ?? message);
    if (audio) return audio;

    const content = message?.content;
    if (Array.isArray(content)) {
      const media = this.extractMediaFromParts(content);
      if (media) return media;
    }

    return null;
  }

  private extractChatToolCalls(data: any): any[] | undefined {
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(toolCalls) && toolCalls.length > 0 ? toolCalls : undefined;
  }

  private buildResponsesToolCall(raw: any): any | null {
    if (!raw || typeof raw !== 'object') return null;
    const name = raw?.name
      ?? raw?.function?.name
      ?? raw?.tool?.name
      ?? raw?.tool_name
      ?? raw?.tool?.function?.name;
    if (!name || typeof name !== 'string') return null;

    const rawArgs = raw?.arguments
      ?? raw?.function?.arguments
      ?? raw?.tool?.arguments
      ?? raw?.tool_call?.arguments
      ?? raw?.args
      ?? raw?.parameters;
    let argumentsPayload = '{}';
    if (typeof rawArgs === 'string') {
      argumentsPayload = rawArgs;
    } else if (typeof rawArgs !== 'undefined') {
      try {
        argumentsPayload = JSON.stringify(rawArgs);
      } catch {
        argumentsPayload = String(rawArgs);
      }
    }

    const id = raw?.call_id ?? raw?.id ?? raw?.tool_call_id ?? raw?.tool_call?.id;
    return {
      id: typeof id === 'string' && id.length > 0 ? id : `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: {
        name,
        arguments: argumentsPayload,
      },
    };
  }

  private extractResponsesToolCalls(data: any): any[] | undefined {
    if (Array.isArray(data?.tool_calls) && data.tool_calls.length > 0) return data.tool_calls;
    if (Array.isArray(data?.response?.tool_calls) && data.response.tool_calls.length > 0) return data.response.tool_calls;

    const outputList = Array.isArray(data?.output) ? data.output : (data?.output ? [data.output] : []);
    const responseOutputList = Array.isArray(data?.response?.output)
      ? data.response.output
      : (data?.response?.output ? [data.response.output] : []);
    const candidates = [...outputList, ...responseOutputList];
    if (data?.item) candidates.push(data.item);
    if (data?.output_item) candidates.push(data.output_item);
    if (data?.response?.output_item) candidates.push(data.response.output_item);

    const collected: any[] = [];
    const pushToolCall = (rawCall: any) => {
      const call = this.buildResponsesToolCall(rawCall);
      if (call) collected.push(call);
    };

    for (const entry of candidates) {
      if (!entry || typeof entry !== 'object') continue;
      if (Array.isArray(entry?.tool_calls) && entry.tool_calls.length > 0) return entry.tool_calls;
      if (entry?.type === 'tool_calls' && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        return entry.tool_calls;
      }
      if (entry?.type === 'tool_call' || entry?.type === 'function_call') {
        pushToolCall(entry);
        continue;
      }

      const content = Array.isArray(entry?.content) ? entry.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (Array.isArray(part?.tool_calls) && part.tool_calls.length > 0) return part.tool_calls;
        if (part?.type === 'tool_calls' && Array.isArray(part.tool_calls) && part.tool_calls.length > 0) {
          return part.tool_calls;
        }
        if (part?.type === 'tool_call' || part?.type === 'function_call') {
          pushToolCall(part);
        }
      }
    }

    return collected.length > 0 ? collected : undefined;
  }

  private extractToolCalls(data: any, useResponsesApi: boolean): any[] | undefined {
    return useResponsesApi ? this.extractResponsesToolCalls(data) : this.extractChatToolCalls(data);
  }

  private extractFinishReason(data: any, useResponsesApi: boolean): string | undefined {
    if (useResponsesApi) {
      return data?.status || data?.response?.status;
    }
    return data?.choices?.[0]?.finish_reason;
  }

  private extractResponseText(data: any, useResponsesApi: boolean): string | null {
    if (useResponsesApi) {
      const media = this.extractMediaFromResponsesOutput(data?.output)
        || this.extractMediaFromResponsesOutput(data?.response?.output);
      if (media) return media;

      if (typeof data?.output_text === 'string') return data.output_text;
      if (typeof data?.response?.output_text === 'string') return data.response.output_text;
      const output = data?.output;
      if (Array.isArray(output) && output.length > 0) {
        for (const entry of output) {
          const content = entry?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part?.text === 'string') return part.text;
              if (typeof part?.delta === 'string') return part.delta;
            }
          }
        }
      }
      const toolCalls = this.extractResponsesToolCalls(data);
      if (Array.isArray(toolCalls) && toolCalls.length > 0) return '';
      return null;
    }

    const message = data?.choices?.[0]?.message;
    const media = this.extractMediaFromChatMessage(message);
    if (media) return media;

    const raw = message?.content;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw)) {
      const normalized = this.normalizeContent(raw);
      if (typeof normalized === 'string' && normalized.length > 0) return normalized;

      for (const part of raw) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string' && part.text.length > 0) return part.text;
        if (typeof part.transcript === 'string' && part.transcript.length > 0) return part.transcript;
        if (typeof part.output_text === 'string' && part.output_text.length > 0) return part.output_text;
        if (part.audio && typeof part.audio.transcript === 'string' && part.audio.transcript.length > 0) return part.audio.transcript;
      }
    }

    const audioTranscript = message?.audio?.transcript;
    if (typeof audioTranscript === 'string' && audioTranscript.length > 0) return audioTranscript;

    // Audio-only outputs may omit text fields; avoid failing the whole provider attempt.
    if (message?.audio || Array.isArray(raw)) return '[Audio output generated]';

    const toolCalls = message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return '';

    return null;
  }

  private extractResponsesStreamChunk(parsed: any): string {
    const media = this.extractMediaFromResponsesOutput(parsed?.output)
      || this.extractMediaFromResponsesOutput(parsed?.response?.output)
      || this.extractMediaFromParts(Array.isArray(parsed?.content) ? parsed.content : []);
    if (media) return media;

    const audio = this.extractAudioFromPart(parsed?.audio ?? parsed?.output_audio ?? parsed);
    if (audio) return audio;

    const toolCalls = this.extractResponsesToolCalls(parsed);
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return '';

    return parsed?.delta
      || parsed?.output_text_delta
      || parsed?.output_text
      || parsed?.response?.delta
      || parsed?.response?.output_text_delta
      || parsed?.response?.output_text
      || parsed?.output?.[0]?.content?.[0]?.delta
      || parsed?.output?.[0]?.content?.[0]?.text
      || '';
  }

  private extractChatStreamChunk(parsed: any): string {
    const delta = parsed?.choices?.[0]?.delta;
    const message = parsed?.choices?.[0]?.message;

    const media = this.extractMediaFromParts(Array.isArray(delta?.content) ? delta.content : [])
      || this.extractAudioFromPart(delta?.audio ?? delta)
      || this.extractMediaFromParts(Array.isArray(message?.content) ? message.content : [])
      || this.extractAudioFromPart(message?.audio ?? message);
    if (media) return media;

    return delta?.content
      || parsed?.choices?.[0]?.delta?.text
      || parsed?.choices?.[0]?.delta?.transcript
      || parsed?.choices?.[0]?.delta?.audio?.transcript
      || parsed?.choices?.[0]?.message?.audio?.transcript
      || '';
  }

  // Removed getLatency and getProviderData methods

  /**
   * Sends a message to the OpenAI API.
   * This method is now stateless and only focuses on the API interaction.
   * @param message - The message to send, including the model details.
   * @returns A promise containing the API response content and latency.
   */
  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    // Removed busy flag management
    const startTime = Date.now();
    const forcedResponses = this.hasCustomEndpoint && this.isResponsesEndpoint(this.endpointUrl);
    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, forcedResponses || message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, forcedResponses || message.useResponsesApi);

    const headers = this.buildHeaders();

    const data = useResponsesApi
      ? this.buildResponsesPayload(message, false)
      : this.buildChatPayload(message, false);
    const stripped = this.stripUnsupportedParamsFromPayload(data, message.model.id);
    const requestData = stripped.cleaned;

    try {
      const timeoutMs = this.getRequestTimeoutMs();
      const response = await axios.post(url, requestData, { headers, timeout: timeoutMs });
      const endTime = Date.now();
      const latency = endTime - startTime;

      const responseText = this.extractResponseText(response.data, useResponsesApi);
      if (responseText === null || responseText === undefined) {
        console.error('Unexpected response structure from API:', response.data);
        throw new Error('Unexpected response structure from the API');
      }

      return {
        response: responseText,
        latency: latency,
        usage: this.extractUsage(response.data, useResponsesApi),
        tool_calls: this.extractToolCalls(response.data, useResponsesApi),
        finish_reason: this.extractFinishReason(response.data, useResponsesApi),
      };
    } catch (error: any) {
      const missingInput = useResponsesApi && this.isMissingInputError(error);
      const missingMessages = !useResponsesApi && this.isMissingMessagesError(error);

      if (useResponsesApi && (error?.response?.status === 400 || missingInput)) {
        console.error('[OpenAI][Responses] 400 payload summary:', this.summarizeResponsesPayload(requestData));
      }

      const unsupportedParams = this.extractUnsupportedParams(error);
      if (unsupportedParams.length > 0) {
        this.recordUnsupportedParams(message.model.id, unsupportedParams);
        const retried = this.stripUnsupportedParamsFromPayload(requestData, message.model.id, unsupportedParams);
        if (retried.removed.length > 0) {
          try {
            const retryStart = Date.now();
            const retryResp = await axios.post(url, retried.cleaned, { headers, timeout: this.getRequestTimeoutMs() });
            const retryLatency = Date.now() - retryStart;
            const retryText = this.extractResponseText(retryResp.data, useResponsesApi);
            if (retryText !== null && retryText !== undefined) {
              return {
                response: retryText,
                latency: retryLatency,
                usage: this.extractUsage(retryResp.data, useResponsesApi),
                tool_calls: this.extractToolCalls(retryResp.data, useResponsesApi),
                finish_reason: this.extractFinishReason(retryResp.data, useResponsesApi),
              };
            }
          } catch (retryError: any) {
            console.error('Retry after stripping unsupported params failed:', retryError);
          }
        }
      }
      // If responses API rejects, try chat once as a fallback (skip if endpoint explicitly targets responses)
      const responsesOnly = this.isResponsesOnlyModel(message.model.id);
      if (useResponsesApi && (error?.response?.status === 400 || missingInput) && !forcedResponses && !responsesOnly) {
        try {
          const chatUrl = this.resolveChatEndpoint();
          const chatPayload = this.buildChatPayload(message, false);
          const chatStripped = this.stripUnsupportedParamsFromPayload(chatPayload, message.model.id);
          const chatStart = Date.now();
          const chatResp = await axios.post(chatUrl, chatStripped.cleaned, { headers, timeout: this.getRequestTimeoutMs() });
          const chatLatency = Date.now() - chatStart;
          const chatText = this.extractResponseText(chatResp.data, false);
          if (chatText !== null && chatText !== undefined) {
            return {
              response: chatText,
              latency: chatLatency,
              usage: this.extractUsage(chatResp.data, false),
              tool_calls: this.extractToolCalls(chatResp.data, false),
              finish_reason: this.extractFinishReason(chatResp.data, false),
            };
          }
        } catch (fallbackError: any) {
          console.error('Chat fallback after responses API 400 failed:', fallbackError);
        }
      }
      if (!useResponsesApi && missingMessages) {
        try {
          const responsesUrl = this.resolveResponsesEndpoint();
          const responsesPayload = this.buildResponsesPayload(message, false);
          const responsesStripped = this.stripUnsupportedParamsFromPayload(responsesPayload, message.model.id);
          const responsesStart = Date.now();
          const responsesResp = await axios.post(responsesUrl, responsesStripped.cleaned, { headers, timeout: this.getRequestTimeoutMs() });
          const responsesLatency = Date.now() - responsesStart;
          const responsesText = this.extractResponseText(responsesResp.data, true);
          if (responsesText !== null && responsesText !== undefined) {
            return {
              response: responsesText,
              latency: responsesLatency,
              usage: this.extractUsage(responsesResp.data, true),
              tool_calls: this.extractToolCalls(responsesResp.data, true),
              finish_reason: this.extractFinishReason(responsesResp.data, true),
            };
          }
        } catch (fallbackError: any) {
          console.error('Responses fallback after chat missing messages failed:', fallbackError);
        }
      }
      // Removed busy flag management
      // Removed internal state updates on error

      const endTime = Date.now(); // Still useful to know when the error occurred
      const latency = endTime - startTime;
      console.error(`Error during sendMessage to ${url} (Latency: ${latency}ms):`, {
        message: error?.message,
        status: error?.response?.status,
        data: error?.response?.data,
      });

      // Extract a more specific error message if possible
      const errorMessage = this.extractApiErrorMessage(error);
      // Rethrow the error to be handled by the MessageHandler
      throw new Error(`API call failed: ${errorMessage}`);
    }
  }

  async createPassthroughStream(message: IMessage): Promise<ProviderStreamPassthrough | null> {
    if (this.isAudioModel(message.model.id)) {
      return null;
    }

    const forcedResponses = this.hasCustomEndpoint && this.isResponsesEndpoint(this.endpointUrl);
    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, forcedResponses || message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, forcedResponses || message.useResponsesApi);
    const headers = this.buildHeaders();
    const data = useResponsesApi
      ? this.buildResponsesPayload(message, true)
      : this.buildChatPayload(message, true);
    const stripped = this.stripUnsupportedParamsFromPayload(data, message.model.id);
    const requestData = stripped.cleaned;

    const response = await this.postSseRequest(url, requestData, headers);
    return {
      upstream: response.data,
      mode: useResponsesApi ? 'openai-responses-sse' : 'openai-chat-sse',
    };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const startTime = Date.now();
    const forcedResponses = this.hasCustomEndpoint && this.isResponsesEndpoint(this.endpointUrl);
    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, forcedResponses || message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, forcedResponses || message.useResponsesApi);

    const headers = this.buildHeaders();

    const data = useResponsesApi
      ? this.buildResponsesPayload(message, true)
      : this.buildChatPayload(message, true);
    const stripped = this.stripUnsupportedParamsFromPayload(data, message.model.id);
    const requestData = stripped.cleaned;

    try {
      const response = await this.postSseRequest(url, requestData, headers);
      let fullResponse = '';
      const consumeSseChunk = this.createSseConsumer();

      for await (const value of response.data) {
        const dataMessages = consumeSseChunk(value);
        for (const dataMessage of dataMessages) {
          if (dataMessage === '[DONE]') {
            const latency = Date.now() - startTime;
            yield { chunk: '', latency, response: fullResponse, anystream: response.data };
            return;
          }
          try {
            const parsed = JSON.parse(dataMessage);
            let chunk = '';
            const toolCalls = this.extractToolCalls(parsed, useResponsesApi);
            const finishReason = this.extractFinishReason(parsed, useResponsesApi);
            if (useResponsesApi) {
              // Handle Responses API SSE events
              if (parsed?.type === 'response.completed') {
                const latency = Date.now() - startTime;
                yield { chunk: '', latency, response: fullResponse, anystream: response.data, tool_calls: toolCalls, finish_reason: finishReason };
                return;
              }
              chunk = this.extractResponsesStreamChunk(parsed);
            } else {
              chunk = this.extractChatStreamChunk(parsed);
            }
            fullResponse += chunk;
            const latency = Date.now() - startTime;
            yield { chunk, latency, response: fullResponse, anystream: response.data, tool_calls: toolCalls, finish_reason: finishReason };
          } catch (error) {
            console.error('Error parsing stream chunk:', error);
          }
        }
      }
    } catch (error: any) {
      const missingInput = useResponsesApi && this.isMissingInputError(error);
      const missingMessages = !useResponsesApi && this.isMissingMessagesError(error);

      if (useResponsesApi && (error?.response?.status === 400 || missingInput)) {
        console.error('[OpenAI][Responses][Stream] 400 payload summary:', this.summarizeResponsesPayload(requestData));
      }

      const unsupportedParams = this.extractUnsupportedParams(error);
      if (unsupportedParams.length > 0) {
        this.recordUnsupportedParams(message.model.id, unsupportedParams);
        const retried = this.stripUnsupportedParamsFromPayload(requestData, message.model.id, unsupportedParams);
        if (retried.removed.length > 0) {
          try {
            const retryResp = await this.postSseRequest(url, retried.cleaned, headers);
            let fullResponse = '';
            const consumeRetryChunk = this.createSseConsumer();

            for await (const value of retryResp.data) {
              const dataMessages = consumeRetryChunk(value);
              for (const dataMessage of dataMessages) {
                if (dataMessage === '[DONE]') {
                  const latency = Date.now() - startTime;
                  yield { chunk: '', latency, response: fullResponse, anystream: retryResp.data };
                  return;
                }
                try {
                  const parsed = JSON.parse(dataMessage);
                  let chunk = '';
                  const toolCalls = this.extractToolCalls(parsed, useResponsesApi);
                  const finishReason = this.extractFinishReason(parsed, useResponsesApi);
                  if (useResponsesApi) {
                    if (parsed?.type === 'response.completed') {
                      const latency = Date.now() - startTime;
                      yield { chunk: '', latency, response: fullResponse, anystream: retryResp.data, tool_calls: toolCalls, finish_reason: finishReason };
                      return;
                    }
                    chunk = this.extractResponsesStreamChunk(parsed);
                  } else {
                    chunk = this.extractChatStreamChunk(parsed);
                  }
                  fullResponse += chunk;
                  const latency = Date.now() - startTime;
                  yield { chunk, latency, response: fullResponse, anystream: retryResp.data, tool_calls: toolCalls, finish_reason: finishReason };
                } catch (retryParseError) {
                  console.error('Error parsing retry stream chunk:', retryParseError);
                }
              }
            }
            return;
          } catch (retryError: any) {
            console.error('Retry stream after stripping unsupported params failed:', retryError);
          }
        }
      }
      // If responses API stream 400s, retry once on chat stream
      const responsesOnly = this.isResponsesOnlyModel(message.model.id);
      if (useResponsesApi && (error?.response?.status === 400 || missingInput) && !forcedResponses && !responsesOnly) {
        try {
          const chatUrl = this.resolveChatEndpoint();
          const chatPayload = this.buildChatPayload(message, true);
          const chatStripped = this.stripUnsupportedParamsFromPayload(chatPayload, message.model.id);
          const chatResp = await this.postSseRequest(chatUrl, chatStripped.cleaned, headers);
          let fullResponse = '';
          const consumeChatSseChunk = this.createSseConsumer();

          for await (const value of chatResp.data) {
            const dataMessages = consumeChatSseChunk(value);
            for (const dataMessage of dataMessages) {
              if (dataMessage === '[DONE]') {
                const latency = Date.now() - startTime;
                yield { chunk: '', latency, response: fullResponse, anystream: chatResp.data };
                return;
              }
              try {
                const parsed = JSON.parse(dataMessage);
                const chunk = this.extractChatStreamChunk(parsed);
                const toolCalls = this.extractToolCalls(parsed, false);
                const finishReason = this.extractFinishReason(parsed, false);
                fullResponse += chunk;
                const latency = Date.now() - startTime;
                yield { chunk, latency, response: fullResponse, anystream: chatResp.data, tool_calls: toolCalls, finish_reason: finishReason };
              } catch (parseErr) {
                console.error('Error parsing chat fallback stream chunk:', parseErr);
              }
            }
          }
          return;
        } catch (fallbackError: any) {
          console.error('Chat stream fallback after responses API 400 failed:', fallbackError);
        }
      }
      if (!useResponsesApi && missingMessages) {
        try {
          const responsesUrl = this.resolveResponsesEndpoint();
          const responsesPayload = this.buildResponsesPayload(message, true);
          const responsesStripped = this.stripUnsupportedParamsFromPayload(responsesPayload, message.model.id);
          const responsesResp = await this.postSseRequest(responsesUrl, responsesStripped.cleaned, headers);
          let fullResponse = '';
          const consumeResponsesSseChunk = this.createSseConsumer();

          for await (const value of responsesResp.data) {
            const dataMessages = consumeResponsesSseChunk(value);
            for (const dataMessage of dataMessages) {
              if (dataMessage === '[DONE]') {
                const latency = Date.now() - startTime;
                yield { chunk: '', latency, response: fullResponse, anystream: responsesResp.data };
                return;
              }
              try {
                const parsed = JSON.parse(dataMessage);
                if (parsed?.type === 'response.completed') {
                  const latency = Date.now() - startTime;
                  yield { chunk: '', latency, response: fullResponse, anystream: responsesResp.data };
                  return;
                }
                const chunk = this.extractResponsesStreamChunk(parsed);
                fullResponse += chunk;
                const latency = Date.now() - startTime;
                yield { chunk, latency, response: fullResponse, anystream: responsesResp.data };
              } catch (parseErr) {
                console.error('Error parsing responses fallback stream chunk:', parseErr);
              }
            }
          }
          return;
        } catch (fallbackError: any) {
          console.error('Responses stream fallback after chat missing messages failed:', fallbackError);
        }
      }
      const latency = Date.now() - startTime;
      console.error(`Error during sendMessageStream to ${url} (Latency: ${latency}ms):`, {
        message: error?.message,
        status: error?.response?.status,
        data: error?.response?.data,
      });
      const errorMessage = String(error?.message || this.extractApiErrorMessage(error));
      if (errorMessage.startsWith('API stream call failed:')) {
        throw new Error(errorMessage);
      }
      throw new Error(`API stream call failed: ${errorMessage}`);
    }
  }
}
