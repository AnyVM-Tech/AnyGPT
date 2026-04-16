#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
from typing import Any


def emit(payload: dict[str, Any], *, exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)


def fail(message: str, *, detail: str | None = None, exit_code: int = 1) -> None:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if detail:
        payload["detail"] = detail
    emit(payload, exit_code=exit_code)


try:
    from openhands.sdk.llm import LLM, Message, content_to_str
except Exception as exc:  # pragma: no cover - import path failure is surfaced to caller
    fail(
        "Failed to import openhands-sdk. Install it in the control-plane Python environment.",
        detail=str(exc),
    )


def coerce_temperature(value: Any) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return numeric


def coerce_timeout_seconds(value: Any) -> int | None:
    if value is None:
        return None
    try:
        timeout_ms = int(value)
    except (TypeError, ValueError):
        return None
    if timeout_ms <= 0:
        return None
    return max(1, math.ceil(timeout_ms / 1000))


def coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def build_messages(raw_messages: Any) -> list[Message]:
    if not isinstance(raw_messages, list):
        raise ValueError("messages must be a list")

    messages: list[Message] = []
    allowed_roles = {"system", "user", "assistant", "tool"}
    for index, entry in enumerate(raw_messages):
        if not isinstance(entry, dict):
            raise ValueError(f"messages[{index}] must be an object")
        role = str(entry.get("role") or "").strip()
        if role not in allowed_roles:
            raise ValueError(f"messages[{index}].role must be one of {sorted(allowed_roles)}")
        messages.append(Message(role=role, content=coerce_text(entry.get("content"))))
    return messages


def main() -> None:
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        fail("OpenHands bridge received empty input.")

    try:
        request = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        fail("OpenHands bridge received invalid JSON input.", detail=str(exc))

    try:
        model = str(request.get("model") or "").strip()
        if not model:
            raise ValueError("model is required")

        messages = build_messages(request.get("messages"))
        base_url = str(request.get("baseUrl") or "").strip() or None
        api_key = str(request.get("apiKey") or "").strip() or None
        temperature = coerce_temperature(request.get("temperature"))
        timeout = coerce_timeout_seconds(request.get("timeout_ms"))

        llm = LLM(
            model=model,
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
        )

        completion_kwargs: dict[str, Any] = {}
        if temperature is not None:
            completion_kwargs["temperature"] = temperature

        response = llm.completion(messages, **completion_kwargs)
        assistant_text = content_to_str(response.message.content)
        emit(
            {
                "ok": True,
                "provider": "openhands-sdk",
                "model": model,
                "content": assistant_text,
            }
        )
    except Exception as exc:
        fail("OpenHands SDK completion failed.", detail=str(exc))


if __name__ == "__main__":
    main()
