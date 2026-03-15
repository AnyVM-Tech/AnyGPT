import axios from 'axios';
import { IAIProvider, IMessage, ProviderResponse, ProviderStreamChunk, ProviderStreamPassthrough } from './interfaces.js';
import { logUniqueProviderError } from '../modules/errorLogger.js';

/**
 * DeepSeek provider (OpenAI-compatible chat completions).
 */
export class DeepseekAI implements IAIProvider {
  private apiKey: string;
  private endpointUrl: string;

  private extractReasoning(raw: any): string | undefined {
    if (typeof raw === 'string') {
      return raw.trim() || undefined;
    }
    if (Array.isArray(raw)) {
      const joined = raw
        .map((entry) => this.extractReasoning(entry) || '')
        .filter(Boolean)
        .join('');
      return joined || undefined;
    }
    if (!raw || typeof raw !== 'object') return undefined;
    if (typeof raw.text === 'string') return raw.text.trim() || undefined;
    if (typeof raw.reasoning === 'string') return raw.reasoning.trim() || undefined;
    if (typeof raw.reasoning_content === 'string') return raw.reasoning_content.trim() || undefined;
    return undefined;
  }

  constructor(apiKey: string, endpointUrl?: string) {
    if (!apiKey) throw new Error('DeepSeek API key is required');
    this.apiKey = apiKey;
    this.endpointUrl = endpointUrl || 'https://api.deepseek.com/chat/completions';
  }

  private buildHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    } as Record<string, string>;
  }

  private buildMessages(message: IMessage) {
    const sourceMessages = Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : [{
          role: message.role || 'user',
          content: message.content,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? { tool_calls: message.tool_calls } : {}),
          ...(typeof message.tool_call_id === 'string' && message.tool_call_id.trim() ? { tool_call_id: message.tool_call_id.trim() } : {}),
          ...(typeof message.name === 'string' && message.name.trim() ? { name: message.name.trim() } : {}),
        }];
    return sourceMessages.map((entry) => ({
      role: typeof entry.role === 'string' && entry.role.trim() ? entry.role : 'user',
      content: entry.content,
      ...(Array.isArray((entry as any).tool_calls) && (entry as any).tool_calls.length > 0
        ? { tool_calls: (entry as any).tool_calls }
        : {}),
      ...(typeof (entry as any).tool_call_id === 'string' && (entry as any).tool_call_id.trim()
        ? { tool_call_id: (entry as any).tool_call_id.trim() }
        : {}),
      ...(typeof (entry as any).name === 'string' && (entry as any).name.trim()
        ? { name: (entry as any).name.trim() }
        : {}),
    }));
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

  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    const start = Date.now();
    const payload = {
      model: message.model.id,
      messages: this.buildMessages(message),
      tools: this.normalizeChatTools(message.tools) ?? message.tools,
      tool_choice: this.normalizeChatToolChoice(message.tool_choice),
      reasoning: message.reasoning,
    };

    try {
      const res = await axios.post(this.endpointUrl, payload, { headers: this.buildHeaders() });
      const latency = Date.now() - start;
      const raw = res.data?.choices?.[0]?.message?.content;

      const normalize = (val: any): string => {
        if (typeof val === 'string') return val;
        if (Array.isArray(val)) {
          for (const part of val) {
            if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
            if (part?.type === 'text' && typeof part.text === 'string') return part.text;
          }
        }
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
      };

      const text = normalize(raw);
      return {
        response: text,
        latency,
        reasoning: this.extractReasoning(
          res.data?.choices?.[0]?.message?.reasoning
          ?? res.data?.choices?.[0]?.message?.reasoning_content
          ?? res.data?.choices?.[0]?.message?.reasoning_details
        ),
        usage: {
          prompt_tokens: typeof res.data?.usage?.prompt_tokens === 'number' ? res.data.usage.prompt_tokens : undefined,
          completion_tokens: typeof res.data?.usage?.completion_tokens === 'number' ? res.data.usage.completion_tokens : undefined,
          total_tokens: typeof res.data?.usage?.total_tokens === 'number' ? res.data.usage.total_tokens : undefined,
        },
        tool_calls: Array.isArray(res.data?.choices?.[0]?.message?.tool_calls)
          ? res.data.choices[0].message.tool_calls
          : undefined,
        finish_reason: res.data?.choices?.[0]?.finish_reason,
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      void logUniqueProviderError({
        provider: 'deepseek',
        operation: 'sendMessage',
        modelId: message.model?.id,
        endpoint: this.endpointUrl,
        latencyMs: latency,
        error,
      });
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown DeepSeek error';
      const wrappedError = new Error(`DeepSeek API call failed: ${msg} (latency ${latency}ms)`);
      (wrappedError as any).__providerUniqueLogged = true;
      throw wrappedError;
    }
  }

  async createPassthroughStream(message: IMessage): Promise<ProviderStreamPassthrough | null> {
    const payload = {
      model: message.model.id,
      messages: this.buildMessages(message),
      stream: true,
      tools: this.normalizeChatTools(message.tools) ?? message.tools,
      tool_choice: this.normalizeChatToolChoice(message.tool_choice),
      reasoning: message.reasoning,
    };
    const res = await axios.post(this.endpointUrl, payload, { headers: this.buildHeaders(), responseType: 'stream' });
    return {
      upstream: res.data,
      mode: 'openai-chat-sse',
    };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const start = Date.now();
    const payload = {
      model: message.model.id,
      messages: this.buildMessages(message),
      stream: true,
      tools: this.normalizeChatTools(message.tools) ?? message.tools,
      tool_choice: this.normalizeChatToolChoice(message.tool_choice),
      reasoning: message.reasoning,
    };

    try {
      const res = await axios.post(this.endpointUrl, payload, { headers: this.buildHeaders(), responseType: 'stream' });
      let full = '';
      for await (const value of res.data) {
        const lines = value.toString('utf8').split('\n').filter((line: string) => line.trim().startsWith('data: '));
        for (const line of lines) {
          const payloadLine = line.replace(/^data: /, '');
          if (payloadLine === '[DONE]') {
            const latency = Date.now() - start;
            yield { chunk: '', latency, response: full, anystream: res.data };
            return;
          }
          try {
            const parsed = JSON.parse(payloadLine);
            const delta = parsed.choices?.[0]?.delta;
            const chunk = delta?.content || '';
            const reasoning = this.extractReasoning(
              delta?.reasoning
              ?? delta?.reasoning_content
              ?? delta?.reasoning_details
              ?? parsed?.choices?.[0]?.message?.reasoning
              ?? parsed?.choices?.[0]?.message?.reasoning_content
            );
            full += chunk;
            const latency = Date.now() - start;
            yield {
              chunk,
              latency,
              response: full,
              reasoning,
              anystream: res.data,
              tool_calls: Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined,
              finish_reason: parsed?.choices?.[0]?.finish_reason,
            };
          } catch {
            // skip malformed chunk
          }
        }
      }
    } catch (error: any) {
      const latency = Date.now() - start;
      void logUniqueProviderError({
        provider: 'deepseek',
        operation: 'sendMessageStream',
        modelId: message.model?.id,
        endpoint: this.endpointUrl,
        latencyMs: latency,
        error,
      });
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown DeepSeek stream error';
      const wrappedError = new Error(`DeepSeek API stream call failed: ${msg} (latency ${latency}ms)`);
      (wrappedError as any).__providerUniqueLogged = true;
      throw wrappedError;
    }
  }
}
