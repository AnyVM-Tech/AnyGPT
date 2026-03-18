export type GeminiErrorClassification = {
  retryable: boolean;
  code?: number;
  reason: string;
};

export function classifyGeminiError(error: unknown): GeminiErrorClassification {
  const message = String(error instanceof Error ? error.message : error ?? "");
  const normalized = message.toLowerCase();
  const codeMatch = message.match(/\[(\d{3})\s+[^[\]]+\]/);
  const code = codeMatch ? Number(codeMatch[1]) : undefined;

  if (
    code === 400 &&
    normalized.includes("cannot fetch content from the provided url")
  ) {
    return {
      retryable: false,
      code,
      reason: "invalid_remote_media_url",
    };
  }

  if (code === 429 || code === 503 || normalized.includes("service unavailable")) {
    return {
      retryable: true,
      code,
      reason: "upstream_unavailable",
    };
  }

  return {
    retryable: code ? code >= 500 : false,
    code,
    reason: "unknown",
  };
}
