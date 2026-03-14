import type { Request, Response } from '../lib/uws-compat.js';
import { fetchWithTimeout } from './http.js';
import {
  buildResponsesCompletedEvent,
  buildResponsesContentPartAddedEvent,
  buildResponsesContentPartDoneEvent,
  buildResponsesCreatedEvent,
  buildResponsesOutputItemAddedEvent,
  buildResponsesOutputItemDoneEvent,
  buildResponsesOutputTextDeltaEvent,
  buildResponsesOutputTextDoneEvent,
  buildResponsesResponseObject,
  createResponsesItemId,
  createResponsesMessageItem,
} from './openaiResponsesFormat.js';
import { updateUserTokenUsage } from './userData.js';
import { enforceModelCapabilities, pickImageGenProviderKey, pickVideoGenProviderKey } from './openaiProviderSelection.js';

type FallbackSource = 'chat' | 'responses';

function writeResponsesEvent(response: Response, payload: Record<string, any>): void {
  response.write(`event: ${payload.type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendResponsesTextResult(params: {
  response: Response;
  modelId: string;
  contentText: string;
  usage: Record<string, number>;
  stream: boolean;
}): void {
  const { response, modelId, contentText, usage, stream } = params;
  const responseId = createResponsesItemId('resp');
  const created = Math.floor(Date.now() / 1000);
  const messageId = createResponsesItemId('msg');
  const responseBody = buildResponsesResponseObject({
    id: responseId,
    created,
    model: modelId,
    outputText: contentText,
    status: 'completed',
    messageId,
    messageStatus: 'completed',
    usage,
  });

  if (!stream) {
    if (!(response as any).completed) response.json(responseBody);
    return;
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  try { (response as any).flushHeaders?.(); } catch {}

  const pendingMessageItem = createResponsesMessageItem('', { id: messageId, status: 'in_progress' });
  const finalMessageItem = Array.isArray(responseBody.output)
    ? responseBody.output.find((item: any) => item?.type === 'message' && item?.role === 'assistant')
    : undefined;
  const finalTextPart = Array.isArray(finalMessageItem?.content) && finalMessageItem.content.length > 0
    ? finalMessageItem.content[0]
    : { type: 'output_text', text: contentText };

  writeResponsesEvent(response, buildResponsesCreatedEvent({
    id: responseId,
    object: 'response',
    created,
    model: modelId,
    status: 'in_progress',
    output: [],
    output_text: '',
  }));
  writeResponsesEvent(response, buildResponsesOutputItemAddedEvent({
    responseId,
    outputIndex: 0,
    item: pendingMessageItem,
  }));
  writeResponsesEvent(response, buildResponsesContentPartAddedEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    part: { type: 'output_text', text: '' },
  }));
  writeResponsesEvent(response, buildResponsesOutputTextDeltaEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    delta: contentText,
  }));
  writeResponsesEvent(response, buildResponsesOutputTextDoneEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    text: contentText,
  }));
  writeResponsesEvent(response, buildResponsesContentPartDoneEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    part: finalTextPart,
  }));
  writeResponsesEvent(response, buildResponsesOutputItemDoneEvent({
    responseId,
    outputIndex: 0,
    item: finalMessageItem || createResponsesMessageItem(contentText, { id: messageId, status: 'completed' }),
  }));
  writeResponsesEvent(response, buildResponsesCompletedEvent(responseBody));
  response.write('data: [DONE]\n\n');
  response.end();
}

export async function handleImageGenFallbackFromChatOrResponses(params: {
  modelId: string;
  prompt: string;
  requestBody: any;
  request: Request;
  response: Response;
  source: FallbackSource;
  upstreamTimeoutMs: number;
}) {
  const { modelId, prompt, requestBody, request, response, source, upstreamTimeoutMs } = params;

  if (!prompt) {
    if (!(response as any).completed) {
      response.status(400).json({
        error: {
          message: `Bad Request: prompt is required for image generation (fallback from /v1/${source}).`,
          type: 'invalid_request_error',
          param: 'prompt',
          code: 'missing_prompt',
        },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  const capsOk = await enforceModelCapabilities(modelId, ['image_output'], response);
  if (!capsOk) return;

  const provider = await pickImageGenProviderKey(modelId, ['image_output']);
  if (!provider) {
    if (!(response as any).completed) {
      response.status(503).json({ error: 'No available provider for image generation', timestamp: new Date().toISOString() });
    }
    return;
  }

  const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      prompt,
      n: typeof requestBody?.n === 'number' ? requestBody.n : 1,
      size: typeof requestBody?.size === 'string' ? requestBody.size : '1024x1024',
      quality: typeof requestBody?.quality === 'string' ? requestBody.quality : undefined,
      style: typeof requestBody?.style === 'string' ? requestBody.style : undefined,
      response_format: typeof requestBody?.response_format === 'string' ? requestBody.response_format : undefined,
    }),
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    if (!(response as any).completed) {
      response.status(upstreamRes.status).json({
        error: `Image generation upstream error: ${errText || upstreamRes.statusText}`,
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  const resJson = await upstreamRes.json();
  const first = Array.isArray(resJson?.data) ? resJson.data[0] : undefined;
  const imageUrl = typeof first?.url === 'string' ? first.url : undefined;
  const imageB64 = typeof first?.b64_json === 'string' ? first.b64_json : undefined;
  const imageDataUrl = imageB64 ? `data:image/png;base64,${imageB64}` : undefined;
  const imageRef = imageUrl || imageDataUrl;
  const content = imageRef ? `![generated image](${imageRef})` : 'Image generation completed.';

  const wantsStream = Boolean(requestBody?.stream);
  if (source === 'chat' && wantsStream) {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    try { (response as any).flushHeaders?.(); } catch {}

    const firstChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: null,
      }],
    };
    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  } else if (source === 'chat') {
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = Math.ceil(prompt.length / 4);
    const totalTokens = promptTokens + 1;
    response.json({
      id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: totalTokens },
    });
  } else {
    const promptTokens = Math.ceil(prompt.length / 4);
    const totalTokens = promptTokens + 1;
    sendResponsesTextResult({
      response,
      modelId,
      contentText: content,
      usage: { input_tokens: promptTokens, output_tokens: 1, total_tokens: totalTokens },
      stream: wantsStream,
    });
  }

  const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
  await updateUserTokenUsage(tokenEstimate, request.apiKey!);
}

export async function handleVideoGenFallbackFromChatOrResponses(params: {
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  response: Response;
  source: FallbackSource;
  upstreamTimeoutMs: number;
  setVideoRequestCache: (requestId: string, provider: { apiKey: string; baseUrl: string }) => void;
}) {
  const { modelId, prompt, imageUrl, requestBody, response, source, upstreamTimeoutMs, setVideoRequestCache } = params;

  if (!prompt) {
    if (!(response as any).completed) {
      response.status(400).json({
        error: {
          message: `Bad Request: prompt is required for video generation (fallback from /v1/${source}).`,
          type: 'invalid_request_error',
          param: 'prompt',
          code: 'missing_prompt',
        },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  const provider = await pickVideoGenProviderKey(modelId);
  if (!provider) {
    if (!(response as any).completed) {
      response.status(503).json({ error: 'No available provider for video generation', timestamp: new Date().toISOString() });
    }
    return;
  }

  const payload: Record<string, any> = { model: modelId, prompt };
  if (typeof requestBody?.image_url === 'string') payload.image_url = requestBody.image_url;
  if (typeof requestBody?.video_url === 'string') payload.video_url = requestBody.video_url;
  if (imageUrl && !payload.image_url) payload.image_url = imageUrl;
  if (typeof requestBody?.duration === 'number') payload.duration = requestBody.duration;
  if (typeof requestBody?.aspect_ratio === 'string') payload.aspect_ratio = requestBody.aspect_ratio;
  if (typeof requestBody?.resolution === 'string') payload.resolution = requestBody.resolution;
  if (typeof requestBody?.seed === 'number') payload.seed = requestBody.seed;

  const upstreamUrl = `${provider.baseUrl}/v1/videos/generations`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(payload),
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    if (!(response as any).completed) {
      response.status(upstreamRes.status).json({
        error: `Video generation upstream error: ${errText || upstreamRes.statusText}`,
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  const resJson = await upstreamRes.json().catch(() => ({}));
  const requestId = resJson?.request_id || resJson?.id;
  if (!requestId) {
    if (!(response as any).completed) {
      response.status(502).json({ error: 'Video generation upstream response missing request_id.', timestamp: new Date().toISOString() });
    }
    return;
  }

  setVideoRequestCache(String(requestId), provider);

  const contentText = `Video generation started. Request ID: ${requestId}. Check /v1/videos/${requestId} for status.`;
  const wantsStream = Boolean(requestBody?.stream);

  if (source === 'chat') {
    if (wantsStream) {
      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      try { (response as any).flushHeaders?.(); } catch {}

      const firstChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }]
      };
      response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      response.write(`data: [DONE]\n\n`);
      return response.end();
    }

    const openaiResponse = {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: contentText },
        logprobs: null,
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    if (!(response as any).completed) response.json(openaiResponse);
    return;
  }

  const promptTokens = Math.ceil(prompt.length / 4);
  const totalTokens = promptTokens + 1;
  sendResponsesTextResult({
    response,
    modelId,
    contentText,
    usage: { input_tokens: promptTokens, output_tokens: 1, total_tokens: totalTokens },
    stream: wantsStream,
  });
}
