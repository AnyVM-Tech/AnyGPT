export type GovernanceFeedbackSignal = {
  status: "ok" | "no_samples" | "error";
  sampleCount: number;
  message?: string;
};

export function normalizeGovernanceFeedbackSignal(
  sampledFeedback: unknown,
  error?: unknown,
): GovernanceFeedbackSignal {
  if (error) {
    return {
      status: "error",
      sampleCount: 0,
      message: error instanceof Error ? error.message : "Failed to inspect governance feedback signal.",
    };
  }

  if (!Array.isArray(sampledFeedback) || sampledFeedback.length === 0) {
    return {
      status: "no_samples",
      sampleCount: 0,
      message: "No sampled feedback items were available for governance signal inspection.",
    };
  }

  return {
    status: "ok",
    sampleCount: sampledFeedback.length,
  };
}
