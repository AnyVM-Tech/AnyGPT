#!/usr/bin/env python3
"""Shared helpers and signal definitions for SurfaceScope research lanes.

This module is intentionally free of heavy dependencies (faster-whisper,
yt-dlp) so that the website lane and the unified implementation lane can
import it without pulling in the full YouTube transcription stack.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass(frozen=True)
class SignalDefinition:
    id: str
    title: str
    priority: str
    rationale: str
    note: str
    suggested_paths: tuple[str, ...]
    keywords: tuple[str, ...]


SIGNAL_DEFINITIONS: tuple[SignalDefinition, ...] = (
    SignalDefinition(
        id="durable_ingestion_jobs",
        title="Persist long-running ingestion jobs",
        priority="high",
        rationale="Research evidence points to long-running agents, retries, queues, or resumability.",
        note="Add checkpointed, resumable import runs instead of single-shot fetch scripts.",
        suggested_paths=(
            "apps/exposure-studio/backend/lane_shared.py",
            "apps/exposure-studio/run.sh",
            "apps/exposure-studio/src/main.rs",
        ),
        keywords=("long running", "langlebig", "resume", "resum", "retry", "checkpoint", "queue", "worker", "planner", "scheduled task", "state"),
    ),
    SignalDefinition(
        id="evals_and_regressions",
        title="Add research-backed evals and regressions",
        priority="high",
        rationale="Research evidence references evals, benchmarks, graders, or test harnesses.",
        note="Build deterministic tests for research lanes so parser changes do not silently degrade output quality.",
        suggested_paths=(
            "apps/exposure-studio/src/main.rs",
            "apps/exposure-studio/data/testing_methodologies.json",
        ),
        keywords=("eval", "evaluation", "benchmark", "deepeval", "grader", "regression", "accuracy", "judge", "test harness"),
    ),
    SignalDefinition(
        id="structured_outputs",
        title="Normalize lane output into strict JSON contracts",
        priority="high",
        rationale="Research evidence references schemas, extraction, parsing, or structured outputs.",
        note="Keep each stage machine-readable so downstream product surfaces can trust the lane output.",
        suggested_paths=(
            "apps/exposure-studio/src/models.rs",
            "apps/exposure-studio/data/.generated/implementation_lane.json",
        ),
        keywords=("structured output", "structured outputs", "schema", "json", "parser", "extract", "classification", "normalize"),
    ),
    SignalDefinition(
        id="human_approval_loops",
        title="Keep approval gates around high-risk actions",
        priority="medium",
        rationale="Research evidence references review, approval, or human-in-the-loop controls.",
        note="Route externalized decisions through reviewer approval rather than letting automation publish or escalate by itself.",
        suggested_paths=(
            "apps/exposure-studio/src/main.rs",
            "apps/exposure-studio/data/findings.json",
        ),
        keywords=("human in the loop", "approval", "review", "confirm", "owner confirmation", "human approval", "human review"),
    ),
    SignalDefinition(
        id="retrieval_memory",
        title="Build a searchable research memory",
        priority="medium",
        rationale="Research evidence references RAG, memory, retrieval, or context management.",
        note="Persist research-derived notes so later product features can reuse collected evidence without reprocessing raw sources.",
        suggested_paths=(
            "apps/exposure-studio/data/.generated/implementation_lane.json",
            "apps/exposure-studio/src/main.rs",
        ),
        keywords=("rag", "retrieval", "knowledge base", "vector", "supabase", "docling", "memory", "context", "notes"),
    ),
    SignalDefinition(
        id="observability_provenance",
        title="Track lane observability and evidence provenance",
        priority="medium",
        rationale="Research evidence references tracing, observability, monitoring, or audit trails.",
        note="Store generation timestamps, transcript status, and evidence snippets so operators can audit what the lane actually learned.",
        suggested_paths=(
            "apps/exposure-studio/src/main.rs",
            "apps/exposure-studio/backend/lane_shared.py",
        ),
        keywords=("langsmith", "trace", "observability", "monitor", "telemetry", "audit trail", "logging"),
    ),
    SignalDefinition(
        id="multi_stage_decomposition",
        title="Decompose the lane into small, reviewable stages",
        priority="medium",
        rationale="Research evidence references sub-agents, specialization, or parallel decomposition.",
        note="Keep fetch, transcribe, enrich, and aggregate as separate stages with explicit handoffs.",
        suggested_paths=(
            "apps/exposure-studio/backend/lane_shared.py",
            "apps/exposure-studio/src/models.rs",
        ),
        keywords=("sub-agent", "subagent", "multi-agent", "specialized", "parallel", "handoff", "decompose", "decomposition"),
    ),
    SignalDefinition(
        id="workflow_adapters",
        title="Wrap external feeds behind adapter-style importers",
        priority="low",
        rationale="Research evidence references workflow tools, triggers, or automation adapters.",
        note="Keep source-specific acquisition code behind a narrow importer interface so the product can add more channels later.",
        suggested_paths=(
            "apps/exposure-studio/backend/lane_shared.py",
            "apps/exposure-studio/run.sh",
        ),
        keywords=("workflow", "automation", "n8n", "make.com", "integration", "trigger", "webhook"),
    ),
)


# ---------------------------------------------------------------------------
# Page-category exclusion for signal extraction
# ---------------------------------------------------------------------------

_LOW_SIGNAL_PATH_SEGMENTS = frozenset((
    "privacy-policy",
    "privacy",
    "cookie-policy",
    "cookie",
    "terms-of-service",
    "terms-and-conditions",
    "terms",
    "legal",
    "disclaimer",
    "imprint",
    "impressum",
    "contact",
    "about-us",
    "gdpr",
    "dmca",
    "accessibility",
    "sitemap",
))


def is_low_signal_url(url: str) -> bool:
    """Return True if *url* points to a page category that should not
    contribute to implementation signal extraction (legal, policy, contact,
    etc.)."""
    if not url:
        return False
    parsed = urlparse(url)
    path_lower = parsed.path.strip("/").lower()
    if not path_lower:
        return False
    segments = path_lower.split("/")
    return any(segment in _LOW_SIGNAL_PATH_SEGMENTS for segment in segments)


def website_page_importance(category: str) -> float:
    normalized = str(category or "").strip().lower()
    if normalized == "article":
        return 1.0
    if normalized == "landing_page":
        return 0.8
    if normalized == "discovered_internal_link":
        return 0.6
    if normalized == "blog_index":
        return 0.5
    if normalized == "category_archive":
        return 0.4
    return 0.5


def website_page_importance_legend() -> dict[str, float]:
    return {
        "article": 1.0,
        "landing_page": 0.8,
        "discovered_internal_link": 0.6,
        "blog_index": 0.5,
        "category_archive": 0.4,
        "default": 0.5,
    }


def weighted_score_description() -> str:
    return "Weighted recommendation score favors richer source pages over aggregate or navigational ones."


# ---------------------------------------------------------------------------
# Shared text helpers
# ---------------------------------------------------------------------------

def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def env_or_default(name: str, fallback: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or fallback


def sanitize_text(value: str) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    return text


def split_sentences(text: str) -> list[str]:
    normalized = sanitize_text(text)
    if not normalized:
        return []
    sentences = re.split(r"(?<=[.!?])\s+", normalized)
    return [sentence.strip() for sentence in sentences if sentence.strip()]


def extract_signals(
    text: str,
    *,
    page_url: str = "",
) -> tuple[list[str], list[str], list[str]]:
    """Extract implementation signals from *text*.

    If *page_url* resolves to a low-signal page category (privacy policy,
    terms, contact, etc.), the function short-circuits and returns empty
    results so that legal/policy boilerplate does not inflate signal counts.
    """
    if page_url and is_low_signal_url(page_url):
        return [], [], []

    sentences = split_sentences(text)
    lowered_sentences = [sentence.lower() for sentence in sentences]
    signal_ids: list[str] = []
    notes: list[str] = []
    evidence: list[str] = []

    for definition in SIGNAL_DEFINITIONS:
        matches: list[str] = []
        for sentence, lowered in zip(sentences, lowered_sentences):
            if any(keyword in lowered for keyword in definition.keywords):
                matches.append(sentence)
        if not matches:
            continue
        signal_ids.append(definition.id)
        notes.append(definition.note)
        for snippet in matches[:2]:
            if snippet not in evidence:
                evidence.append(snippet)

    return signal_ids, notes, evidence[:6]


_SOURCE_SUGGESTED_PATH_OVERRIDES: dict[str, dict[str, tuple[str, ...]]] = {
    "youtube": {
        "durable_ingestion_jobs": (
            "apps/exposure-studio/backend/youtube_research_runner.py",
            "apps/exposure-studio/.lane-secrets.env",
            "apps/exposure-studio/run.sh",
        ),
        "structured_outputs": (
            "apps/exposure-studio/src/models.rs",
            "apps/exposure-studio/data/.generated/youtube_implementation_lane.json",
        ),
        "retrieval_memory": (
            "apps/exposure-studio/data/.generated/youtube_implementation_lane.json",
            "apps/exposure-studio/src/main.rs",
        ),
        "observability_provenance": (
            "apps/exposure-studio/backend/youtube_research_runner.py",
            "apps/exposure-studio/data/.generated/youtube-cache",
        ),
        "multi_stage_decomposition": (
            "apps/exposure-studio/backend/youtube_research_runner.py",
            "apps/exposure-studio/src/models.rs",
        ),
        "workflow_adapters": (
            "apps/exposure-studio/backend/youtube_research_runner.py",
            "apps/exposure-studio/run.sh",
        ),
    },
    "website": {
        "durable_ingestion_jobs": (
            "apps/exposure-studio/backend/website_research_runner.py",
            "apps/exposure-studio/data/research_web_targets.json",
            "apps/exposure-studio/run.sh",
        ),
        "structured_outputs": (
            "apps/exposure-studio/src/models.rs",
            "apps/exposure-studio/data/.generated/website_implementation_lane.json",
        ),
        "retrieval_memory": (
            "apps/exposure-studio/data/.generated/website_implementation_lane.json",
            "apps/exposure-studio/src/main.rs",
        ),
        "observability_provenance": (
            "apps/exposure-studio/backend/website_research_runner.py",
            "apps/exposure-studio/data/.generated/website_implementation_lane.json",
        ),
        "multi_stage_decomposition": (
            "apps/exposure-studio/backend/website_research_runner.py",
            "apps/exposure-studio/src/models.rs",
        ),
        "workflow_adapters": (
            "apps/exposure-studio/backend/website_research_runner.py",
            "apps/exposure-studio/data/research_web_targets.json",
        ),
    },
    "implementation": {
        "durable_ingestion_jobs": (
            "apps/exposure-studio/backend/implementation_lane_runner.py",
            "apps/exposure-studio/run.sh",
            "apps/exposure-studio/data/.generated/implementation_lane.json",
        ),
        "structured_outputs": (
            "apps/exposure-studio/src/models.rs",
            "apps/exposure-studio/data/.generated/implementation_lane.json",
        ),
        "retrieval_memory": (
            "apps/exposure-studio/data/.generated/implementation_lane.json",
            "apps/exposure-studio/src/main.rs",
        ),
        "observability_provenance": (
            "apps/exposure-studio/backend/implementation_lane_runner.py",
            "apps/exposure-studio/data/.generated/.lane-snapshots",
        ),
        "multi_stage_decomposition": (
            "apps/exposure-studio/backend/implementation_lane_runner.py",
            "apps/exposure-studio/src/models.rs",
        ),
        "workflow_adapters": (
            "apps/exposure-studio/backend/implementation_lane_runner.py",
            "apps/exposure-studio/run.sh",
        ),
    },
}


def resolve_suggested_paths(definition: SignalDefinition, source_type: str) -> list[str]:
    source_key = str(source_type or "").strip().lower()
    override = _SOURCE_SUGGESTED_PATH_OVERRIDES.get(source_key, {}).get(definition.id)
    if override:
        return list(override)
    return list(definition.suggested_paths)


def read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return loaded if isinstance(loaded, dict) else None


def write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def lane_snapshot_path(output_path: Path) -> Path:
    snapshot_dir = output_path.parent / ".lane-snapshots"
    return snapshot_dir / f"{output_path.stem}.last-good.json"


def load_last_good_lane(output_path: Path) -> dict[str, Any] | None:
    return read_json_file(lane_snapshot_path(output_path))


def save_last_good_lane(output_path: Path, payload: dict[str, Any]) -> None:
    write_json_file(lane_snapshot_path(output_path), payload)


def lane_lock_path(output_path: Path) -> Path:
    lock_dir = output_path.parent / ".lane-locks"
    return lock_dir / f"{output_path.stem}.lock"


def lock_owner_is_active(lock_path: Path) -> bool:
    metadata = read_json_file(lock_path)
    if not isinstance(metadata, dict):
        return False
    try:
        pid = int(metadata.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@contextlib.contextmanager
def acquire_lane_lock(output_path: Path, *, timeout_seconds: float = 10.0, poll_seconds: float = 0.25):
    lock_path = lane_lock_path(output_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = time.monotonic()
    fd: int | None = None

    while fd is None:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            payload = {
                "pid": os.getpid(),
                "acquired_at": iso_now(),
                "target": str(output_path),
            }
            os.write(fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            os.close(fd)
            fd = 0
        except FileExistsError:
            if not lock_owner_is_active(lock_path):
                lock_path.unlink(missing_ok=True)
                continue
            if timeout_seconds <= 0 or (time.monotonic() - started_at) >= timeout_seconds:
                raise RuntimeError(
                    f"Lane lock is already held for {output_path.name} ({lock_path})."
                )
            time.sleep(max(0.01, poll_seconds))

    try:
        yield lock_path
    finally:
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass
