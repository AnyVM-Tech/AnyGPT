export type LangSmithFeedbackItem = Record<string, unknown>;

export function normalizeSampledFeedbackItems(input: unknown): LangSmithFeedbackItem[] {
  if (Array.isArray(input)) {
    return input.filter((item): item is LangSmithFeedbackItem => !!item && typeof item === 'object');
  }

  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const candidates = [record.items, record.feedback, record.data];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((item): item is LangSmithFeedbackItem => !!item && typeof item === 'object');
      }
    }
  }

  return [];
}

export function getSampledFeedbackStatus(input: unknown): {
  items: LangSmithFeedbackItem[];
  empty: boolean;
  reason?: string;
} {
  const items = normalizeSampledFeedbackItems(input);
  if (items.length > 0) {
    return { items, empty: false };
  }

  return {
    items,
    empty: true,
    reason: 'No sampled feedback items were available for governance signal inspection.',
  };
}
