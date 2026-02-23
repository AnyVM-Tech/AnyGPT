import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';
import { IAIProvider, IMessage, ProviderResponse, ProviderStreamChunk, ProviderStreamPassthrough } from './interfaces.js';

interface OpenRouterOptions {
  referer?: string;
  title?: string;
}

/**
 * OpenRouter provider: OpenAI-compatible but requires Referer and X-Title headers.
 */
export class OpenRouterAI implements IAIProvider {
  private apiKey: string;
  private endpointUrl: string;
  private referer?: string;
  private title?: string;

  constructor(apiKey: string, endpointUrl?: string, options: OpenRouterOptions = {}) {
    if (!apiKey) throw new Error('OpenRouter API key is required');
    this.apiKey = apiKey;
    this.endpointUrl = endpointUrl || 'https://openrouter.ai/api/v1/chat/completions';
    this.referer = options.referer || process.env.OPENROUTER_REFERRER;
    this.title = options.title || process.env.OPENROUTER_TITLE;
  }

  private buildHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers['HTTP-Referer'] = this.referer;
    if (this.title) headers['X-Title'] = this.title;
    return headers;
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

    const directUrl = audioObj?.url ?? audioObj?.audio_url?.url ?? part?.audio_url;
    if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;

    return null;
  }

  private extractMediaFromMessage(message: any): string | null {
    if (!message || typeof message !== 'object') return null;

    const audio = this.extractAudioFromPart(message?.audio ?? message);
    if (audio) return audio;

    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const image = this.extractImageFromPart(part);
        if (image) return image;
        const audioPart = this.extractAudioFromPart(part);
        if (audioPart) return audioPart;
      }
    } else if (content && typeof content === 'object') {
      const image = this.extractImageFromPart(content);
      if (image) return image;
      const audioPart = this.extractAudioFromPart(content);
      if (audioPart) return audioPart;
    }

    return null;
  }

  private readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private readEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private readEnvCsv(name: string): string[] | null {
    const raw = process.env[name];
    if (!raw) return null;
    const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
  }

  private isLocalHostname(host: string): boolean {
    const normalized = host.toLowerCase();
    return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local');
  }

  private isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
    const [a, b, c, d] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }

  private isPrivateIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('2001:db8')) return true;
    if (normalized.startsWith('::ffff:')) {
      const ipv4 = normalized.slice('::ffff:'.length);
      if (ipv4) return this.isPrivateIpv4(ipv4);
    }
    return false;
  }

  private isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) return this.isPrivateIpv4(ip);
    if (net.isIPv6(ip)) return this.isPrivateIpv6(ip);
    return false;
  }

  private hostMatchesAllowlist(host: string, allowedHosts: string[] | null): boolean {
    if (!allowedHosts || allowedHosts.length === 0) return true;
    const needle = host.toLowerCase();
    return allowedHosts.some((entry) => {
      const allowed = entry.toLowerCase();
      if (!allowed) return false;
      if (allowed.startsWith('.')) {
        const suffix = allowed.slice(1);
        return needle === suffix || needle.endsWith(`.${suffix}`);
      }
      return needle === allowed;
    });
  }

  private async resolveHostAddresses(host: string): Promise<string[]> {
    try {
      const res = await dns.lookup(host, { all: true });
      return res.map((entry) => entry.address);
    } catch {
      return [];
    }
  }

  private async validateImageFetchUrl(
    rawUrl: string,
    allowedProtocols: string[],
    allowedHosts: string[] | null,
    allowPrivate: boolean
  ): Promise<{ ok: boolean; parsed?: URL }> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false };
    }

    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    if (!allowedProtocols.includes(protocol)) return { ok: false };

    const hostname = parsed.hostname;
    if (!hostname) return { ok: false };
    if (!this.hostMatchesAllowlist(hostname, allowedHosts)) return { ok: false };

    if (!allowPrivate) {
      if (this.isLocalHostname(hostname)) return { ok: false };
      const directIpType = net.isIP(hostname);
      if (directIpType) {
        if (this.isPrivateIp(hostname)) return { ok: false };
      } else {
        const addresses = await this.resolveHostAddresses(hostname);
        if (addresses.length === 0) return { ok: false };
        if (addresses.some((addr) => this.isPrivateIp(addr))) return { ok: false };
      }
    }

    return { ok: true, parsed };
  }

  private async readResponseBodyWithLimit(response: globalThis.Response, maxBytes: number, controller?: AbortController): Promise<Buffer> {
    const contentLength = response.headers.get('content-length');
    if (maxBytes > 0 && contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller?.abort(new Error('Image exceeds max size.'));
        throw new Error('Image exceeds max size.');
      }
    }

    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        try { await reader.cancel(); } catch {}
        controller?.abort(new Error('Image exceeds max size.'));
        throw new Error('Image exceeds max size.');
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  private detectMimeTypeFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 2) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
    if (buffer.length > 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
    return null;
  }

  private async fetchImageAsDataUrl(imageUrl: string, refererOverride?: string): Promise<string | null> {
    const allowedProtocols = (this.readEnvCsv('IMAGE_FETCH_ALLOWED_PROTOCOLS') ?? ['http', 'https']).map((p) => p.toLowerCase());
    const allowedHosts = this.readEnvCsv('IMAGE_FETCH_ALLOWED_HOSTS');
    const allowPrivate = this.readEnvBool('IMAGE_FETCH_ALLOW_PRIVATE', false);
    const maxRedirects = this.readEnvNumber('IMAGE_FETCH_MAX_REDIRECTS', 3);
    const timeoutMs = this.readEnvNumber('IMAGE_FETCH_TIMEOUT_MS', 15_000);
    const maxBytes = this.readEnvNumber('IMAGE_FETCH_MAX_BYTES', 8 * 1024 * 1024);
    const userAgent = process.env.IMAGE_FETCH_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    const referer = refererOverride || process.env.IMAGE_FETCH_REFERER;

    const validation = await this.validateImageFetchUrl(imageUrl, allowedProtocols, allowedHosts, allowPrivate);
    if (!validation.ok || !validation.parsed) return null;

    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('Image fetch timed out.')), timeoutMs) : null;
    let currentUrl = validation.parsed.toString();

    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const currentValidation = hop === 0 ? validation : await this.validateImageFetchUrl(currentUrl, allowedProtocols, allowedHosts, allowPrivate);
        if (!currentValidation.ok || !currentValidation.parsed) return null;

        const headers: Record<string, string> = {};
        if (userAgent) headers['User-Agent'] = userAgent;
        if (referer) headers['Referer'] = referer;
        const res = await fetch(currentUrl, { method: 'GET', redirect: 'manual', signal: controller.signal, headers });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) return null;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (!res.ok) return null;

        const buffer = await this.readResponseBodyWithLimit(res, maxBytes, controller);
        const contentType = res.headers.get('content-type') || this.detectMimeTypeFromBuffer(buffer) || 'image/jpeg';
        const base64 = buffer.toString('base64');
        return `data:${contentType};base64,${base64}`;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private getSourceMessages(message: IMessage): Array<{ role: string; content: any }> {
    return Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : [{ role: message.role || 'user', content: message.content }];
  }

  private async inlineImageUrls(sourceMessages: Array<{ role: string; content: any }>, referer?: string): Promise<void> {
    for (const msg of sourceMessages) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type !== 'image_url') continue;
        const urlValue = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (typeof urlValue !== 'string' || !urlValue.startsWith('http')) continue;
        const dataUrl = await this.fetchImageAsDataUrl(urlValue, referer);
        if (!dataUrl) continue;
        if (typeof part.image_url === 'string') {
          part.image_url = { url: dataUrl };
        } else {
          part.image_url = { ...(part.image_url || {}), url: dataUrl };
        }
      }
    }
  }

  private normalizeContent(val: any): string {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      for (const part of val) {
        if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'output_text' && typeof part.output_text === 'string') return part.output_text;
      }
    }
    if (val && typeof val === 'object') {
      if (typeof val.text === 'string') return val.text;
      if (typeof val.transcript === 'string') return val.transcript;
      if (typeof val.output_text === 'string') return val.output_text;
      return JSON.stringify(val);
    }
    return val == null ? '' : String(val);
  }

  private extractErrorMessage(error: any, fallback: string): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    let message = '';

    if (data) {
      if (typeof data === 'string') {
        message = data;
      } else if (typeof data?.error === 'string') {
        message = data.error;
      } else if (data?.error && typeof data.error === 'object') {
        message = data.error?.message || data.error?.error || JSON.stringify(data.error);
      } else if (typeof data?.message === 'string') {
        message = data.message;
      }
    }

    if (!message) message = error?.message || fallback;

    if (data && typeof data === 'object' && message.toLowerCase().includes('provider returned error')) {
      const metadata = data?.error?.metadata;
      if (metadata && typeof metadata === 'object') {
        const provider = metadata?.provider || metadata?.provider_name || metadata?.provider_id;
        const raw = metadata?.raw || metadata?.response || metadata?.body || metadata?.provider_response;
        const rawText = raw
          ? (typeof raw === 'string' ? raw : JSON.stringify(raw))
          : '';
        const trimmed = rawText && rawText.length > 500 ? `${rawText.slice(0, 500)}...` : rawText;
        const parts: string[] = [];
        if (provider) parts.push(`provider=${provider}`);
        if (trimmed) parts.push(`detail=${trimmed}`);
        if (parts.length > 0) {
          message = `${message} (${parts.join(', ')})`;
        }
      }
    }

    if (status) message = `${message} (status ${status})`;
    return message;
  }

  private normalizeMessageContent(content: any): any {
    if (!Array.isArray(content)) return content;
    const textParts: string[] = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
        continue;
      }
      if (part?.type === 'input_text' && typeof part.text === 'string') {
        textParts.push(part.text);
        continue;
      }
      return content;
    }
    return textParts.length > 0 ? textParts.join('\n') : content;
  }

  private buildRequestData(message: IMessage, stream: boolean = false, sourceMessages?: Array<{ role: string; content: any }>) {
    const messages = sourceMessages ?? this.getSourceMessages(message);

    const data: any = {
      model: message.model.id,
      messages: messages.map((entry) => ({
        role: typeof entry.role === 'string' && entry.role.trim() ? entry.role : 'user',
        content: this.normalizeMessageContent(entry.content),
      })),
      stream,
    };
    if (message.modalities) data.modalities = message.modalities;
    if (message.audio) data.audio = message.audio;
    return data;
  }

  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    const start = Date.now();
    const sourceMessages = this.getSourceMessages(message);
    await this.inlineImageUrls(sourceMessages, message.image_fetch_referer);
    const data = this.buildRequestData(message, false, sourceMessages);

    try {
      const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders() });
      const latency = Date.now() - start;
      const messagePayload = res.data?.choices?.[0]?.message;
      const media = this.extractMediaFromMessage(messagePayload);
      const raw = messagePayload?.content;

      const text = media || this.normalizeContent(raw);
      return {
        response: text,
        latency,
        usage: {
          prompt_tokens: typeof res.data?.usage?.prompt_tokens === 'number' ? res.data.usage.prompt_tokens : undefined,
          completion_tokens: typeof res.data?.usage?.completion_tokens === 'number' ? res.data.usage.completion_tokens : undefined,
          total_tokens: typeof res.data?.usage?.total_tokens === 'number' ? res.data.usage.total_tokens : undefined,
        }
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = this.extractErrorMessage(error, 'Unknown OpenRouter error');
      throw new Error(`OpenRouter API call failed: ${msg} (latency ${latency}ms)`);
    }
  }

  async createPassthroughStream(message: IMessage): Promise<ProviderStreamPassthrough | null> {
    const sourceMessages = this.getSourceMessages(message);
    await this.inlineImageUrls(sourceMessages, message.image_fetch_referer);
    const data = this.buildRequestData(message, true, sourceMessages);
    const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders(), responseType: 'stream' });
    return {
      upstream: res.data,
      mode: 'openai-chat-sse',
    };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const start = Date.now();
    const sourceMessages = this.getSourceMessages(message);
    await this.inlineImageUrls(sourceMessages, message.image_fetch_referer);
    const data = this.buildRequestData(message, true, sourceMessages);

    try {
      const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders(), responseType: 'stream' });
      let full = '';
      for await (const value of res.data) {
        const lines = value.toString('utf8').split('\n').filter((line: string) => line.trim().startsWith('data: '));
        for (const line of lines) {
          const payload = line.replace(/^data: /, '');
          if (payload === '[DONE]') {
            const latency = Date.now() - start;
            yield { chunk: '', latency, response: full, anystream: res.data };
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta;
            const message = parsed?.choices?.[0]?.message;
            const media = this.extractMediaFromMessage(delta) || this.extractMediaFromMessage(message);
            const chunk = media
              || this.normalizeContent(delta?.content ?? delta?.text ?? delta?.transcript ?? delta?.audio?.transcript);
            full += chunk;
            const latency = Date.now() - start;
            yield { chunk, latency, response: full, anystream: res.data };
          } catch (e) {
            // Skip malformed chunk
          }
        }
      }
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = this.extractErrorMessage(error, 'Unknown OpenRouter stream error');
      throw new Error(`OpenRouter API stream call failed: ${msg} (latency ${latency}ms)`);
    }
  }
}
