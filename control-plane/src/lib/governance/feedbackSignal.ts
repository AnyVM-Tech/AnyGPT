export type GovernanceFeedbackSignal<T = unknown> = {
  status: "ok" | "empty";
  items: T[];
  message?: string;
};

export function buildGovernanceFeedbackSignal<T = unknown>(items: T[] | null | undefined): GovernanceFeedbackSignal<T> {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      status: "empty",
      items: [],
      message: "No sampled feedback items were available for governance signal inspection.",
    };
  }

  return {
    status: "ok",
    items,
  };
}
