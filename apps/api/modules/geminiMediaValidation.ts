export type GeminiRemoteMediaValidationResult = {
  status: number;
  code: string;
  retryable: boolean;
  clientMessage: string;
  providerSwitchWorthless: boolean;
  requestRetryWorthless: boolean;
  reason?: string;
  detail?: string;
};

const GEMINI_REMOTE_MEDIA_ERROR: GeminiRemoteMediaValidationResult = {
  status: 400,
  code: "GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL",
  retryable: false,
  clientMessage:
    "Invalid request: one or more remote media URLs could not be fetched by Gemini. Use a publicly accessible URL or inline/base64 media content.",
  providerSwitchWorthless: true,
  requestRetryWorthless: true,
  reason: 'remote_media_url_unfetchable_by_gemini',
  detail: 'gemini_remote_media_requires_public_fetchable_url_or_inline_media',
};

const GEMINI_PRIVATE_REMOTE_MEDIA_ERROR: GeminiRemoteMediaValidationResult = {
  status: 400,
  code: "GEMINI_PRIVATE_REMOTE_MEDIA_URL",
  retryable: false,
  clientMessage:
    "Invalid request: one or more remote media URLs point to localhost or a private network address that Gemini cannot fetch. Use a publicly accessible URL or inline/base64 media content.",
  providerSwitchWorthless: true,
  requestRetryWorthless: true,
  reason: 'remote_media_url_private_or_local',
  detail: 'gemini_remote_media_rejected_private_or_local_url',
};

function isRemoteUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) {
    return true;
  }
  if (/^169\.254\./.test(normalized) || /^0\./.test(normalized)) {
    return true;
  }
  return false;
}

function classifyRemoteMedia(value: unknown): 'none' | 'remote' | 'private' {
  if (!value) return 'none';

  if (typeof value === 'string') {
    if (!isRemoteUrl(value)) return 'none';
    try {
      const parsed = new URL(value);
      return isPrivateOrLocalHostname(parsed.hostname) ? 'private' : 'remote';
    } catch {
      return 'remote';
    }
  }

  if (Array.isArray(value)) {
    let sawRemote = false;
    for (const entry of value) {
      const nested = classifyRemoteMedia(entry);
      if (nested === 'private') return 'private';
      if (nested === 'remote') sawRemote = true;
    }
    return sawRemote ? 'remote' : 'none';
  }

  if (typeof value !== 'object') {
    return 'none';
  }

  const record = value as Record<string, unknown>;
  let sawRemote = false;

  const mark = (result: 'none' | 'remote' | 'private') => {
    if (result === 'private') return 'private';
    if (result === 'remote') sawRemote = true;
    return null;
  };

  for (const candidate of [record.image_url, record.audio_url, record.video_url]) {
    const marked = mark(classifyRemoteMedia(candidate));
    if (marked) return marked;
  }

  if (record.url) {
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (type.includes('image') || type.includes('audio') || type.includes('video') || type.includes('media')) {
      const marked = mark(classifyRemoteMedia(record.url));
      if (marked) return marked;
    }
  }

  if (record.input_audio && typeof record.input_audio === 'object') {
    const inputAudio = record.input_audio as Record<string, unknown>;
    const marked = mark(classifyRemoteMedia(inputAudio.url));
    if (marked) return marked;
  }

  if (record.file && typeof record.file === 'object') {
    const file = record.file as Record<string, unknown>;
    const marked = mark(classifyRemoteMedia(file.url));
    if (marked) return marked;
  }

  for (const nested of Object.values(record)) {
    if (nested === value) continue;
    const marked = mark(classifyRemoteMedia(nested));
    if (marked) return marked;
  }

  return sawRemote ? 'remote' : 'none';
}

function containsUnsupportedGeminiAudioMime(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnsupportedGeminiAudioMime(entry));
  }
  if (typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const mimeType = typeof record.mime_type === 'string'
    ? record.mime_type.toLowerCase()
    : typeof record.mimeType === 'string'
      ? record.mimeType.toLowerCase()
      : typeof record.format === 'string'
        ? record.format.toLowerCase()
        : '';

  if (
    type === 'input_audio' &&
    (mimeType === 'audio/s16le' || mimeType === 's16le' || mimeType === 'pcm' || mimeType === 'audio/pcm')
  ) {
    return true;
  }

  if (record.input_audio && containsUnsupportedGeminiAudioMime(record.input_audio)) {
    return true;
  }

  return Object.values(record).some((nested) => nested !== value && containsUnsupportedGeminiAudioMime(nested));
}

function collectRequestModelIds(body: Record<string, unknown>): string[] {
  const candidates = [
    body.model,
    (body as any)?.modelId,
    (body as any)?.model_id,
    (body as any)?.metadata?.model,
    (body as any)?.metadata?.modelId,
    (body as any)?.metadata?.model_id,
  ];

  return candidates
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
}

function requestTargetsLyriaPreview(body: Record<string, unknown>): boolean {
  return collectRequestModelIds(body).some((modelId) => modelId.includes('lyria-3-pro-preview'));
}

function containsToolChoiceRequest(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== 'none';
  }
  if (typeof value === 'object') return true;
  return false;
}

export function validateGeminiRemoteMediaRequest(body: unknown): GeminiRemoteMediaValidationResult | null {
  if (!body || typeof body !== "object") return null;
  const request = body as Record<string, unknown>;

  const classifyAndBuild = (
    value: unknown,
    detailSuffix: string,
  ): GeminiRemoteMediaValidationResult | null => {
    const classification = classifyRemoteMedia(value);
    if (classification === 'private') {
      return {
        ...GEMINI_PRIVATE_REMOTE_MEDIA_ERROR,
        reason: 'remote_media_url_private_or_local',
        detail: `gemini_remote_media_rejected_private_or_local_url_${detailSuffix}`,
      };
    }
    if (classification === 'remote') {
      return {
        ...GEMINI_REMOTE_MEDIA_ERROR,
        reason: 'remote_media_url_unfetchable_by_gemini',
        detail: `gemini_remote_media_requires_public_fetchable_url_or_inline_media_${detailSuffix}`,
      };
    }
    return null;
  };

  if (
    containsUnsupportedGeminiAudioMime(request.messages) ||
    containsUnsupportedGeminiAudioMime(request.input) ||
    containsUnsupportedGeminiAudioMime(request.contents)
  ) {
    const lyriaPreviewTarget = requestTargetsLyriaPreview(request);
    return {
      status: 400,
      code: 'GEMINI_UNSUPPORTED_AUDIO_MIME',
      retryable: false,
      clientMessage: lyriaPreviewTarget
        ? 'Invalid request: lyria-3-pro-preview does not support Gemini generateContent audio_input with raw PCM audio/s16le. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help. Use a supported audio format or transcode before sending.'
        : 'Invalid request: Gemini does not accept raw PCM audio/s16le input for this route. This is an upstream/provider-bound Gemini capability mismatch for generateContent; retrying the same Gemini provider-method combination is unlikely to help. Use a supported audio format or transcode before sending.',
      providerSwitchWorthless: true,
      requestRetryWorthless: true,
      reason: 'unsupported_audio_mime_type_for_gemini',
      detail: lyriaPreviewTarget
        ? 'gemini_generatecontent_audio_input_unsupported_audio_s16le_lyria_3_pro_preview'
        : 'gemini_generatecontent_audio_input_unsupported_audio_s16le',
    };
  }

  if (requestTargetsLyriaPreview(request) && containsToolChoiceRequest(request.tool_choice ?? request.toolChoice)) {
    return {
      status: 400,
      code: 'GEMINI_TOOL_CALLING_UNSUPPORTED_MODEL',
      retryable: false,
      clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini function calling for this route. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
      providerSwitchWorthless: true,
      requestRetryWorthless: true,
      reason: 'gemini_tool_calling_not_enabled_for_model',
      detail: 'gemini_generatecontent_tool_calling_not_enabled_lyria_3_pro_preview',
    };
  }

  if (requestTargetsLyriaPreview(request) && Array.isArray(request.modalities) && request.modalities.some((value: unknown) => String(value || '').toLowerCase().trim() === 'image')) {
    return {
      status: 400,
      code: 'GEMINI_IMAGE_OUTPUT_UNSUPPORTED_MODEL',
      retryable: false,
      clientMessage: 'Invalid request: lyria-3-pro-preview image generation is unavailable for this Gemini route in the current country/provider region. This is an upstream/provider-bound Gemini capability mismatch and regional catalog drift; retrying the same Gemini provider-method combination is unlikely to help.',
      providerSwitchWorthless: true,
      requestRetryWorthless: true,
      reason: 'gemini_image_output_unavailable_for_model_region',
      detail: 'gemini_generatecontent_image_output_blocked_lyria_3_pro_preview',
    };
  }

  if (requestTargetsLyriaPreview(request) && Array.isArray(request.modalities) && request.modalities.some((value: unknown) => String(value || '').toLowerCase().trim() === 'audio')) {
    return {
      status: 400,
      code: 'GEMINI_AUDIO_OUTPUT_UNSUPPORTED_MODEL',
      retryable: false,
      clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini audio output for this route. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
      providerSwitchWorthless: true,
      requestRetryWorthless: true,
      reason: 'gemini_audio_output_not_enabled_for_model',
      detail: 'gemini_generatecontent_audio_output_not_enabled_lyria_3_pro_preview',
    };
  }

  const mediaValidation =
    classifyAndBuild(request.messages, 'in_messages') ||
    classifyAndBuild(request.input, 'in_input') ||
    classifyAndBuild(request.contents, 'in_contents') ||
    null;

  if (requestTargetsLyriaPreview(request)) {
    const audioMimeHints = [
      'audio/',
      'audio/s16le',
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/mp3',
      'audio/ogg',
      'audio/webm',
      'audio/flac',
      'audio/aac',
      'audio/mp4',
      'application/ogg',
    ];
    const requestJson = JSON.stringify(request ?? {}).toLowerCase();
    const hasAudioMimeHint = audioMimeHints.some((hint) => requestJson.includes(hint));
    const hasToolCallingHint =
      requestJson.includes('tool_choice') ||
      requestJson.includes('tool_calls') ||
      requestJson.includes('function_declarations') ||
      requestJson.includes('functioncallingconfig') ||
      (Array.isArray((request as any)?.tools) && (request as any).tools.length > 0);
    if (mediaValidation?.reason === 'audio_input_unsupported_for_model' || hasAudioMimeHint) {
      return {
        status: 400,
        code: 'GEMINI_AUDIO_INPUT_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini audio input for this route. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_audio_input_not_enabled_for_model',
        detail: hasAudioMimeHint
          ? 'gemini_generatecontent_audio_input_mime_hint_unsupported_lyria_3_pro_preview'
          : 'gemini_generatecontent_audio_input_unsupported_lyria_3_pro_preview',
      };
    }
    if (hasToolCallingHint) {
      return {
        status: 400,
        code: 'GEMINI_TOOL_CALLING_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini tool calling for this route. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_tool_calling_not_enabled_for_model',
        detail: 'gemini_generatecontent_tool_calling_unsupported_lyria_3_pro_preview',
      };
    }
  }

  return mediaValidation;
}

export function isGeminiRequestRetryWorthless(body: unknown): boolean {
  const validation = validateGeminiRemoteMediaRequest(body);
  return Boolean(validation?.requestRetryWorthless || validation?.providerSwitchWorthless);
}

export function validateGeminiModelCapabilityRequest(modelId: string, body: unknown): GeminiRemoteMediaValidationResult | null {
  const normalizedModelId = String(modelId || '').trim().toLowerCase();
  if (normalizedModelId !== 'lyria-3-pro-preview') return null;

  const request = body && typeof body === 'object' ? body as Record<string, any> : {};
  const requestJson = (() => {
    try {
      return JSON.stringify(request).toLowerCase();
    } catch {
      return '';
    }
  })();

  const hasAudioMimeHint =
    requestJson.includes('audio/s16le') ||
    requestJson.includes('audio/') ||
    requestJson.includes('input_audio') ||
    requestJson.includes('input_audio_file') ||
    requestJson.includes('input_audio_format') ||
    requestJson.includes('audio_url') ||
    requestJson.includes('audio_data') ||
    requestJson.includes('audio_bytes') ||
    requestJson.includes('inline_data') && requestJson.includes('mime_type') && requestJson.includes('audio') ||
    requestJson.includes('file_data') && requestJson.includes('mime_type') && requestJson.includes('audio') ||
    requestJson.includes('type') && requestJson.includes('input_audio');  if (hasAudioMimeHint) {
    return {
      status: 400,
      code: 'GEMINI_AUDIO_INPUT_UNSUPPORTED_MODEL',
      retryable: false,
      clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini audio input for this route. This is an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
      providerSwitchWorthless: true,
      requestRetryWorthless: true,
      reason: 'gemini_audio_input_not_enabled_for_model',
      detail: 'gemini_generatecontent_audio_input_unsupported_lyria_3_pro_preview',
    };
  }

  const hasImageGenerationHint =
    requestJson.includes('image_generation') ||
    requestJson.includes('image output') ||
    requestJson.includes('image_output') ||
    requestJson.includes('generated_images') ||
    requestJson.includes('generated image') ||
    requestJson.includes('modalities') && requestJson.includes('image') ||
    requestJson.includes('response_format') && requestJson.includes('image') ||
    requestJson.includes('output_format') && requestJson.includes('image');

    if (hasImageGenerationHint) {
      return {
        status: 400,
        code: 'GEMINI_IMAGE_OUTPUT_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview image generation is unavailable for this Gemini route. This matches an upstream/provider-bound Gemini capability mismatch and regional catalog drift; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_image_output_unavailable_for_model',
        detail: 'gemini_image_output_blocked_or_unavailable_lyria_3_pro_preview',
      };
    }

    const hasAudioInputHint =
      requestJson.includes('input_audio') ||
      requestJson.includes('input_audio_buffer') ||
      requestJson.includes('input_audio_data') ||
      requestJson.includes('audio_url') ||
      requestJson.includes('input_audio_file') ||
      requestJson.includes('input_audio_transcription') ||
      requestJson.includes('input_audio_format') ||
      requestJson.includes('input_audio_bytes') ||
      requestJson.includes('input_audio_base64') ||
      requestJson.includes('audio/mpeg') ||
      requestJson.includes('audio/mp3') ||
      requestJson.includes('audio/wav') ||
      requestJson.includes('audio/webm') ||
      requestJson.includes('audio/ogg') ||
      requestJson.includes('audio/s16le') ||
      requestJson.includes('transcript');

    if (hasAudioInputHint) {
      return {
        status: 400,
        code: 'GEMINI_AUDIO_INPUT_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini audio input for this route, including unsupported mime types such as audio/s16le. This matches an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_audio_input_unsupported_for_model',
        detail: 'gemini_generatecontent_audio_input_unsupported_lyria_3_pro_preview',
      };
    }

    const hasToolCallingHint =
      requestJson.includes('tool_choice') ||
      requestJson.includes('tool_calls') ||
      requestJson.includes('\"tools\"') ||
      requestJson.includes('function_declarations') ||
      requestJson.includes('function_calling');

    if (hasToolCallingHint) {
      return {
        status: 400,
        code: 'GEMINI_TOOL_CALLING_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini tool calling for this route. This matches an upstream/provider-bound Gemini capability mismatch; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_tool_calling_not_enabled_for_model',
        detail: 'gemini_generatecontent_tool_calling_unsupported_lyria_3_pro_preview',
      };
    }

    const hasImageOutputHint =
      requestJson.includes('image_output') ||
      requestJson.includes('image_generation') ||
      requestJson.includes('generate image') ||
      requestJson.includes('generated_images') ||
      requestJson.includes('response_format') ||
      requestJson.includes('modalities') ||
      requestJson.includes('image/png') ||
      requestJson.includes('image/jpeg');

    if (hasImageOutputHint) {
      return {
        status: 400,
        code: 'GEMINI_IMAGE_OUTPUT_UNSUPPORTED_MODEL',
        retryable: false,
        clientMessage: 'Invalid request: lyria-3-pro-preview does not support Gemini image output for this route in the current provider region/country. This matches an upstream/provider-bound Gemini capability mismatch and regional catalog drift family; retrying the same Gemini provider-method combination is unlikely to help.',
        providerSwitchWorthless: true,
        requestRetryWorthless: true,
        reason: 'gemini_image_output_unavailable_for_model_region',
        detail: 'gemini_image_output_region_blocked_lyria_3_pro_preview',
      };
    }

    return null;
  }