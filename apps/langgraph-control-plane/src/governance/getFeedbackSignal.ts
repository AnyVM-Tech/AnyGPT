export type GovernanceFeedbackSignal = {
  items: unknown[];
  summary: string;
  empty: boolean;
};

export function getFeedbackSignal(items: unknown[] | null | undefined): GovernanceFeedbackSignal {
  const normalizedItems = Array.isArray(items) ? items : [];

  if (normalizedItems.length === 0) {
    console.warn("[governance] No sampled feedback items were available for governance signal inspection.");
    return {
      items: [],
      summary: "No sampled feedback items were available for governance signal inspection.",
      empty: true,
    };
  }

  return {
    items: normalizedItems,
    summary: `Sampled ${normalizedItems.length} feedback item${normalizedItems.length === 1 ? "" : "s"} for governance signal inspection.`,
    empty: false,
  };
}
