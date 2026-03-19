export type GovernanceFeedbackSignal = {
  status: "ok" | "empty";
  summary: string;
  sampleCount: number;
  items: unknown[];
};

export function buildGovernanceFeedbackSignal(items: unknown[] | null | undefined): GovernanceFeedbackSignal {
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    return {
      status: "empty",
      summary: "No sampled feedback items were available for governance signal inspection.",
      sampleCount: 0,
      items: [],
    };
  }

  return {
    status: "ok",
    summary: `Sampled ${safeItems.length} feedback item${safeItems.length === 1 ? "" : "s"} for governance signal inspection.`,
    sampleCount: safeItems.length,
    items: safeItems,
  };
}
