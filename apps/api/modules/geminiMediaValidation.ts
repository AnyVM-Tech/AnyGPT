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

  return (
    classifyAndBuild(request.messages, 'in_messages') ||
    classifyAndBuild(request.input, 'in_input') ||
    classifyAndBuild(request.contents, 'in_contents') ||
    null
  );
}
