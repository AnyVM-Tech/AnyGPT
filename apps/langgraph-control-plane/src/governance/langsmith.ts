export type LangSmithFeedbackSample = Record<string, unknown>

export type LangSmithGovernanceFeedbackResult = {
  items: LangSmithFeedbackSample[]
  empty: boolean
  reason?: string
}

export function normalizeGovernanceFeedbackSamples(
  samples: unknown,
): LangSmithGovernanceFeedbackResult {
  if (!Array.isArray(samples)) {
    return {
      items: [],
      empty: true,
      reason: 'No sampled feedback items were available for governance signal inspection.',
    }
  }

  return {
    items: samples.filter(
      (sample): sample is LangSmithFeedbackSample =>
        !!sample && typeof sample === 'object' && !Array.isArray(sample),
    ),
    empty: samples.length === 0,
    reason:
      samples.length === 0
        ? 'No sampled feedback items were available for governance signal inspection.'
        : undefined,
  }
}
