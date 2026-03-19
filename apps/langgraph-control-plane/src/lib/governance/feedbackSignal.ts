export type GovernanceFeedbackSignal = {
  status: "ok" | "no_feedback";
  sampleCount: number;
  message?: string;
};

export function summarizeGovernanceFeedbackSample<T>(items: T[] | null | undefined): GovernanceFeedbackSignal {
  const sampleCount = Array.isArray(items) ? items.length : 0;

  if (sampleCount === 0) {
    return {
      status: "no_feedback",
      sampleCount: 0,
      message: "No sampled feedback items were available for governance signal inspection.",
    };
  }

  return {
    status: "ok",
    sampleCount,
  };
}
