import type { Response } from '../lib/uws-compat.js';
import { updateUserTokenUsage } from './userData.js';
import { fetchWithTimeout } from './http.js';
import { normalizeInputAudio } from './mediaParsing.js';
import { enforceModelCapabilities, pickOpenAIProviderKey } from './openaiProviderSelection.js';

export const AUDIO_CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export async function forwardTtsToOpenAI(options: {
  modelId: string;
  input: string;
  voice?: string;
  responseFormat?: string;
  speed?: number;
  stream?: boolean;
  userApiKey: string;
  response: Response;
  upstreamTimeoutMs: number;
}) {
  const { modelId, input, voice, responseFormat, speed, stream, userApiKey, response, upstreamTimeoutMs } = options;

  if (!input) {
    if (!(response as any).completed) response.status(400).json({ error: 'Bad Request: input is required for TTS', timestamp: new Date().toISOString() });
    return;
  }

  const capsOk = await enforceModelCapabilities(modelId, ['audio_output'], response);
  if (!capsOk) return;

  const provider = await pickOpenAIProviderKey(modelId, ['audio_output']);
  if (!provider) {
    if (!(response as any).completed) response.status(503).json({ error: 'No available provider for TTS', timestamp: new Date().toISOString() });
    return;
  }

  const upstreamUrl = `${provider.baseUrl}/v1/audio/speech`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      input,
      voice: voice || 'alloy',
      response_format: responseFormat || 'mp3',
      speed,
      stream: Boolean(stream),
    }),
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    if (!(response as any).completed) response.status(upstreamRes.status).json({ error: `TTS upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
    return;
  }

  const upstreamContentType = upstreamRes.headers.get('content-type');
  const contentType = upstreamContentType || AUDIO_CONTENT_TYPES[(responseFormat || 'mp3').toLowerCase()] || 'audio/mpeg';
  response.setHeader('Content-Type', contentType);

  if (stream && upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) response.write(value);
    }
    response.end();
  } else {
    const arrayBuffer = await upstreamRes.arrayBuffer();
    response.end(new Uint8Array(arrayBuffer));
  }

  await updateUserTokenUsage(Math.ceil(input.length / 4), userApiKey);
}

export async function forwardSttToOpenAI(options: {
  modelId: string;
  audio: { data: string; format: string };
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: string;
  userApiKey: string;
  response: Response;
  upstreamTimeoutMs: number;
}) {
  const { modelId, audio, language, prompt, temperature, responseFormat, userApiKey, response, upstreamTimeoutMs } = options;

  const normalized = normalizeInputAudio(audio);
  if (!normalized) {
    if (!(response as any).completed) response.status(400).json({ error: 'Bad Request: invalid input audio', timestamp: new Date().toISOString() });
    return;
  }

  const capsOk = await enforceModelCapabilities(modelId, ['audio_input'], response);
  if (!capsOk) return;

  const provider = await pickOpenAIProviderKey(modelId, ['audio_input']);
  if (!provider) {
    if (!(response as any).completed) response.status(503).json({ error: 'No available provider for STT', timestamp: new Date().toISOString() });
    return;
  }

  const FormDataCtor = (globalThis as any).FormData;
  const BlobCtor = (globalThis as any).Blob;
  if (!FormDataCtor || !BlobCtor) {
    throw new Error('FormData/Blob not available in this Node runtime.');
  }
  const form = new FormDataCtor();
  form.append('model', modelId);
  form.append('file', new BlobCtor([normalized.buffer], { type: normalized.mimeType }), `audio.${normalized.extension}`);
  if (typeof language === 'string') form.append('language', language);
  if (typeof prompt === 'string') form.append('prompt', prompt);
  if (typeof temperature === 'number') form.append('temperature', temperature.toString());
  if (typeof responseFormat === 'string') form.append('response_format', responseFormat);

  const upstreamUrl = `${provider.baseUrl}/v1/audio/transcriptions`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: form,
  }, upstreamTimeoutMs);

  const resContentType = upstreamRes.headers.get('content-type') || 'application/json';
  response.setHeader('Content-Type', resContentType);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    if (!(response as any).completed) response.status(upstreamRes.status).end(errText || upstreamRes.statusText);
    return;
  }

  const resBody = await upstreamRes.text();
  response.end(resBody);

  await updateUserTokenUsage(100, userApiKey);
}
