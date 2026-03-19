export type LangSmithFeedbackItem = Record<string, unknown>;

export type LangSmithFeedbackResult = {
  items: LangSmithFeedbackItem[];
  empty: boolean;
  reason?: string;
};

function isNoSampledFeedbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no sampled feedback items were available/i.test(message);
}

export async function withGracefulEmptySampledFeedback(
  loader: () => Promise<LangSmithFeedbackItem[] | null | undefined>,
): Promise<LangSmithFeedbackResult> {
  try {
    const items = (await loader()) ?? [];
    return {
      items,
      empty: items.length === 0,
      reason: items.length === 0 ? "No sampled feedback items were available for governance signal inspection." : undefined,
    };
  } catch (error) {
    if (isNoSampledFeedbackError(error)) {
      return {
        items: [],
        empty: true,
        reason: "No sampled feedback items were available for governance signal inspection.",
      };
    }
    throw error;
  }
}
