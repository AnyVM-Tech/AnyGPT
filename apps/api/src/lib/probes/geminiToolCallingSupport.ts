export function isGeminiFunctionCallingUnsupported(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  const normalized = message.toLowerCase();
  return (
    normalized.includes("function calling is not enabled") ||
    normalized.includes("function calling is not supported") ||
    normalized.includes("tools are not supported")
  );
}
