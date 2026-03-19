export type LangSmithFeedbackSignalResult = {
  status: 'ok' | 'empty';
  message: string;
  sampleCount: number;
  items: unknown[];
};

export function buildLangSmithFeedbackSignalResult(items: unknown[] | null | undefined): LangSmithFeedbackSignalResult {
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    return {
      status: 'empty',
      message: 'No sampled feedback items were available for governance signal inspection.',
      sampleCount: 0,
      items: [],
    };
  }

  return {
    status: 'ok',
    message: `Loaded ${safeItems.length} sampled feedback item${safeItems.length === 1 ? '' : 's'} for governance signal inspection.`,
    sampleCount: safeItems.length,
    items: safeItems,
  };
}
