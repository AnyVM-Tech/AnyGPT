export type GovernanceFeedbackSample<T = unknown> = {
  items: T[];
  reason?: string;
};

export function normalizeGovernanceFeedbackSample<T = unknown>(sample: T[] | null | undefined): GovernanceFeedbackSample<T> {
  if (!Array.isArray(sample) || sample.length === 0) {
    return {
      items: [],
      reason: 'no_sampled_feedback_items',
    };
  }

  return { items: sample };
}
