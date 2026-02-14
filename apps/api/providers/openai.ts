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

    private extractApiErrorMessage(error: any): string {
      const apiError = error?.response?.data?.error;
      if (apiError) {
        const message = apiError?.message || 'Unknown API error';
        const code = apiError?.code ? ` (code: ${apiError.code})` : '';
        const type = apiError?.type ? ` [${apiError.type}]` : '';
        return `${message}${code}${type}`;
      }
      return error?.message || 'Unknown API error';
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

  private shouldUseResponsesApi(modelId: string, force?: boolean): boolean {
    if (force) return true;
    const normalized = this.normalizeModelId(modelId);
    if (normalized.includes('gpt-5.2')) return true;
    if (normalized.includes('gpt-4.1')) return true;
    if (normalized.includes('o3') || normalized.includes('omni')) return true;
    return normalized.includes('pro');
  }

  private resolveEndpoint(modelId: string, forceResponses?: boolean): string {
    const wantsResponses = this.shouldUseResponsesApi(modelId, forceResponses);
    if (!this.hasCustomEndpoint) return wantsResponses ? OPENAI_RESPONSES_ENDPOINT : OPENAI_CHAT_ENDPOINT;

    if (wantsResponses) {
      if (this.endpointUrl.includes('/chat/completions')) {
        return this.endpointUrl.replace('/chat/completions', '/responses');
      }
      return OPENAI_RESPONSES_ENDPOINT;
    }

    return this.endpointUrl;
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

  private attachChatOptionalParams(target: Record<string, any>, message: IMessage) {
    if (message.system) target.system = message.system;
    if (message.response_format) target.response_format = message.response_format;
    if (typeof message.max_tokens === 'number') target.max_tokens = message.max_tokens;
    if (typeof message.temperature === 'number') target.temperature = message.temperature;
    if (typeof message.top_p === 'number') target.top_p = message.top_p;
    if (message.metadata) target.metadata = message.metadata;
    if (message.tools) target.tools = message.tools;
    if (message.tool_choice) target.tool_choice = message.tool_choice;

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
    if (message.tools) target.tools = message.tools;
    if (message.tool_choice) target.tool_choice = message.tool_choice;
    if (message.reasoning) target.reasoning = message.reasoning;
    if (message.instructions) target.instructions = message.instructions;
    if (message.modalities) target.modalities = message.modalities;
    if (message.audio) target.audio = message.audio;
    return target;
  }

  private normalizeResponsesContentParts(content: any): any[] {
    const parts = Array.isArray(content) ? content : [content];
    const normalized: any[] = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const type = String(part.type || '').toLowerCase();
      if ((type === 'text' || type === 'input_text') && typeof part.text === 'string') {
        normalized.push({ type: 'input_text', text: part.text });
        continue;
      }

      if (type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
        normalized.push({ type: 'image_url', image_url: part.image_url });
        continue;
      }

      if (type === 'input_audio' && part.input_audio && typeof part.input_audio.data === 'string' && typeof part.input_audio.format === 'string') {
        normalized.push({ type: 'input_audio', input_audio: part.input_audio });
      }
    }

    return normalized;
  }

  private normalizeResponsesInput(rawInput: any): any[] {
    if (Array.isArray(rawInput) && rawInput.length > 0 && rawInput.every((entry) => entry && typeof entry === 'object' && 'role' in entry)) {
      return rawInput.map((entry: any) => ({
        ...entry,
        content: this.normalizeResponsesContentParts(entry.content),
      }));
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
    const response = await axios.post(url, data, {
      headers,
      responseType: 'stream',
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
      messages: [{ role: 'user', content: message.content }],
      ...(stream ? { stream: true } : {}),
    };
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
    const input = this.normalizeResponsesInput(message.content);

    const payload: Record<string, any> = {
      model: message.model.id,
      input,
      ...(stream ? { stream: true } : {}),
    };

    return this.attachResponsesOptionalParams(payload, message);
  }

  private extractResponseText(data: any, useResponsesApi: boolean): string | null {
    if (useResponsesApi) {
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
      return null;
    }

    const message = data?.choices?.[0]?.message;
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

    return null;
  }

  private extractResponsesStreamChunk(parsed: any): string {
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
    return parsed?.choices?.[0]?.delta?.content
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
    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, useResponsesApi);

    const headers = this.buildHeaders();

    const data = useResponsesApi
      ? this.buildResponsesPayload(message, false)
      : this.buildChatPayload(message, false);

    try {
      const response = await axios.post(url, data, { headers });
      const endTime = Date.now();
      const latency = endTime - startTime;

      const responseText = this.extractResponseText(response.data, useResponsesApi);
      if (!responseText) {
        console.error('Unexpected response structure from API:', response.data);
        throw new Error('Unexpected response structure from the API');
      }

      return {
        response: responseText,
        latency: latency,
        usage: this.extractUsage(response.data, useResponsesApi)
      };
    } catch (error: any) {
      if (useResponsesApi && error?.response?.status === 400) {
        console.error('[OpenAI][Responses] 400 payload summary:', this.summarizeResponsesPayload(data));
      }
      // If responses API rejects, try chat once as a fallback
      if (useResponsesApi && error?.response?.status === 400) {
        try {
          const chatUrl = this.hasCustomEndpoint
            ? (this.endpointUrl.includes('/responses') ? this.endpointUrl.replace('/responses', '/chat/completions') : this.endpointUrl)
            : OPENAI_CHAT_ENDPOINT;
          const chatPayload = this.buildChatPayload(message, false);
          const chatStart = Date.now();
          const chatResp = await axios.post(chatUrl, chatPayload, { headers });
          const chatLatency = Date.now() - chatStart;
          const chatText = this.extractResponseText(chatResp.data, false);
          if (chatText) {
            return { response: chatText, latency: chatLatency, usage: this.extractUsage(chatResp.data, false) };
          }
        } catch (fallbackError: any) {
          console.error('Chat fallback after responses API 400 failed:', fallbackError);
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

    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, useResponsesApi);
    const headers = this.buildHeaders();
    const data = useResponsesApi
      ? this.buildResponsesPayload(message, true)
      : this.buildChatPayload(message, true);

    const response = await this.postSseRequest(url, data, headers);
    return {
      upstream: response.data,
      mode: useResponsesApi ? 'openai-responses-sse' : 'openai-chat-sse',
    };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const startTime = Date.now();
    const useResponsesApi = this.shouldUseResponsesApi(message.model.id, message.useResponsesApi);
    const url = this.resolveEndpoint(message.model.id, useResponsesApi);

    const headers = this.buildHeaders();

    const data = useResponsesApi
      ? this.buildResponsesPayload(message, true)
      : this.buildChatPayload(message, true);

    try {
      const response = await this.postSseRequest(url, data, headers);
      let fullResponse = '';
      let sseBuffer = '';

      const consumeSseChunk = (rawChunk: any): string[] => {
        const text = Buffer.isBuffer(rawChunk) ? rawChunk.toString('utf8') : String(rawChunk);
        sseBuffer += text;
        const dataLines: string[] = [];

        while (true) {
          const newlineIndex = sseBuffer.indexOf('\n');
          if (newlineIndex === -1) break;

          let line = sseBuffer.slice(0, newlineIndex);
          sseBuffer = sseBuffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data:')) continue;
          dataLines.push(line.slice(5).trimStart());
        }

        return dataLines;
      };

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
            if (useResponsesApi) {
              // Handle Responses API SSE events
              if (parsed?.type === 'response.completed') {
                const latency = Date.now() - startTime;
                yield { chunk: '', latency, response: fullResponse, anystream: response.data };
                return;
              }
              chunk = this.extractResponsesStreamChunk(parsed);
            } else {
              chunk = this.extractChatStreamChunk(parsed);
            }
            fullResponse += chunk;
            const latency = Date.now() - startTime;
            yield { chunk, latency, response: fullResponse, anystream: response.data };
          } catch (error) {
            console.error('Error parsing stream chunk:', error);
          }
        }
      }
    } catch (error: any) {
      if (useResponsesApi && error?.response?.status === 400) {
        console.error('[OpenAI][Responses][Stream] 400 payload summary:', this.summarizeResponsesPayload(data));
      }
      // If responses API stream 400s, retry once on chat stream
      if (useResponsesApi && error?.response?.status === 400) {
        try {
          const chatUrl = this.hasCustomEndpoint
            ? (this.endpointUrl.includes('/responses') ? this.endpointUrl.replace('/responses', '/chat/completions') : this.endpointUrl)
            : OPENAI_CHAT_ENDPOINT;
          const chatPayload = this.buildChatPayload(message, true);
          const chatResp = await this.postSseRequest(chatUrl, chatPayload, headers);
          let fullResponse = '';
          let chatSseBuffer = '';

          const consumeChatSseChunk = (rawChunk: any): string[] => {
            const text = Buffer.isBuffer(rawChunk) ? rawChunk.toString('utf8') : String(rawChunk);
            chatSseBuffer += text;
            const dataLines: string[] = [];

            while (true) {
              const newlineIndex = chatSseBuffer.indexOf('\n');
              if (newlineIndex === -1) break;

              let line = chatSseBuffer.slice(0, newlineIndex);
              chatSseBuffer = chatSseBuffer.slice(newlineIndex + 1);

              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line.startsWith('data:')) continue;
              dataLines.push(line.slice(5).trimStart());
            }

            return dataLines;
          };

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
                fullResponse += chunk;
                const latency = Date.now() - startTime;
                yield { chunk, latency, response: fullResponse, anystream: chatResp.data };
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
