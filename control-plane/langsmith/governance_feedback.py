from __future__ import annotations

from typing import Any, Iterable


EMPTY_FEEDBACK_SIGNAL = "No sampled feedback items were available for governance signal inspection."


def summarize_sampled_feedback(items: Iterable[Any] | None) -> dict[str, Any]:
    """Return a stable governance summary for sampled feedback inspection.

    This helper is intentionally defensive for repair-mode use: callers may pass
    None, an exhausted iterator, or sparse item payloads. In all empty cases we
    return a non-error summary with the known governance signal.
    """
    materialized = list(items or [])
    if not materialized:
        return {
            "ok": True,
            "signal": EMPTY_FEEDBACK_SIGNAL,
            "sample_count": 0,
            "items": [],
        }

    return {
        "ok": True,
        "signal": None,
        "sample_count": len(materialized),
        "items": materialized,
    }
