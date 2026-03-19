export type GovernanceFeedbackSignal =
  | {
      status: 'ok';
      sampledCount: number;
      items: unknown[];
    }
  | {
      status: 'no_feedback';
      sampledCount: 0;
      items: [];
      reason: 'No sampled feedback items were available for governance signal inspection.';
    };

export function normalizeGovernanceFeedbackSignal(
  sampledFeedback: unknown[] | null | undefined,
): GovernanceFeedbackSignal {
  if (!Array.isArray(sampledFeedback) || sampledFeedback.length === 0) {
    return {
      status: 'no_feedback',
      sampledCount: 0,
      items: [],
      reason: 'No sampled feedback items were available for governance signal inspection.',
    };
  }

  return {
    status: 'ok',
    sampledCount: sampledFeedback.length,
    items: sampledFeedback,
  };
}
