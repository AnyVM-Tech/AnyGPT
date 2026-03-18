export type GeminiRemoteMediaValidationResult = {
  status: number;
  code: string;
  retryable: boolean;
  clientMessage: string;
  providerSwitchWorthless: boolean;
  requestRetryWorthless: boolean;
};

const GEMINI_REMOTE_MEDIA_ERROR: GeminiRemoteMediaValidationResult = {
  status: 400,
  code: "GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL",
  retryable: false,
  clientMessage:
    "Invalid request: one or more remote media URLs could not be fetched by Gemini. Use a publicly accessible URL or inline/base64 media content.",
  providerSwitchWorthless: true,
  requestRetryWorthless: true,
};

function isRemoteUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function hasRemoteMedia(value: unknown): boolean {
  if (!value) return false;

  if (Array.isArray(value)) {
    return value.some(hasRemoteMedia);
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (isRemoteUrl(record.image_url)) return true;
  if (isRemoteUrl(record.audio_url)) return true;
  if (isRemoteUrl(record.video_url)) return true;
  if (isRemoteUrl(record.url)) {
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (type.includes("image") || type.includes("audio") || type.includes("video") || type.includes("media")) {
      return true;
    }
  }

  if (record.image_url && typeof record.image_url === "object") {
    const imageUrl = record.image_url as Record<string, unknown>;
    if (isRemoteUrl(imageUrl.url)) return true;
  }

  if (record.input_audio && typeof record.input_audio === "object") {
    const inputAudio = record.input_audio as Record<string, unknown>;
    if (isRemoteUrl(inputAudio.url)) return true;
  }

  if (record.file && typeof record.file === "object") {
    const file = record.file as Record<string, unknown>;
    if (isRemoteUrl(file.url)) return true;
  }

  return Object.values(record).some((nested) => {
    if (nested === value) return false;
    return hasRemoteMedia(nested);
  });
}

export function validateGeminiRemoteMediaRequest(body: unknown): GeminiRemoteMediaValidationResult | null {
  if (!body || typeof body !== "object") return null;
  const request = body as Record<string, unknown>;
  if (!Array.isArray(request.messages)) return null;
  return hasRemoteMedia(request.messages) ? GEMINI_REMOTE_MEDIA_ERROR : null;
}
