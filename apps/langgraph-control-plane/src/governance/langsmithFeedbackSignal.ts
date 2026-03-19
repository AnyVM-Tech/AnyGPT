export type LangSmithFeedbackSignalResult = {
  items: unknown[];
  empty: boolean;
  reason?: string;
};

export function normalizeSampledFeedback(items: unknown[] | null | undefined): LangSmithFeedbackSignalResult {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      items: [],
      empty: true,
      reason: 'No sampled feedback items were available for governance signal inspection.',
    };
  }

  return {
    items,
    empty: false,
  };
}
