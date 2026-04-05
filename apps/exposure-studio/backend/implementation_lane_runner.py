#!/usr/bin/env python3
"""Unified implementation lane runner for website + YouTube research."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from lane_shared import acquire_lane_lock, env_or_default, iso_now, load_last_good_lane, save_last_good_lane, website_page_importance, website_page_importance_legend, weighted_score_description, write_json_file


APP_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = APP_ROOT / "backend"
DEFAULT_GENERATED_DIR = APP_ROOT / "data" / ".generated"
DEFAULT_YOUTUBE_OUTPUT = DEFAULT_GENERATED_DIR / "youtube_implementation_lane.json"
DEFAULT_WEBSITE_OUTPUT = DEFAULT_GENERATED_DIR / "website_implementation_lane.json"
DEFAULT_OUTPUT = DEFAULT_GENERATED_DIR / "implementation_lane.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a unified implementation lane from YouTube and website sources.")
    parser.add_argument(
        "mode",
        nargs="?",
        default="run",
        choices=("run", "doctor"),
        help="Use 'doctor' to run preflight diagnostics across both source lanes.",
    )
    parser.add_argument("--youtube-output", default=env_or_default("YOUTUBE_LANE_OUTPUT", str(DEFAULT_YOUTUBE_OUTPUT)), help="Path to the YouTube lane JSON.")
    parser.add_argument("--website-output", default=env_or_default("WEBSITE_LANE_OUTPUT", str(DEFAULT_WEBSITE_OUTPUT)), help="Path to the website lane JSON.")
    parser.add_argument("--output", default=env_or_default("IMPLEMENTATION_LANE_OUTPUT", str(DEFAULT_OUTPUT)), help="Path to the unified lane JSON.")
    parser.add_argument("--skip-refresh", action="store_true", help="Merge existing lane files without rerunning source-specific runners.")
    return parser.parse_args()


def run_child(command: list[str], allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=str(BACKEND_ROOT), text=True, capture_output=True)
    if result.stderr:
        sys.stderr.write(result.stderr)
    if not allow_failure and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}")
    return result


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def compute_status(coverage: dict[str, int]) -> str:
    youtube_total = int(coverage.get("youtube_video_count") or 0)
    youtube_success = int(coverage.get("youtube_transcribed_video_count") or 0)
    youtube_fail = int(coverage.get("youtube_failed_video_count") or 0)
    website_total = int(coverage.get("website_page_count") or 0)
    website_success = int(coverage.get("website_ingested_page_count") or 0)
    website_fail = int(coverage.get("website_failed_page_count") or 0)

    active_sources = 0
    successful_sources = 0

    if youtube_total > 0:
        active_sources += 1
        if youtube_success > 0:
            successful_sources += 1
    if website_total > 0:
        active_sources += 1
        if website_success > 0:
            successful_sources += 1

    if successful_sources == 0:
        return "unhealthy"

    if active_sources > successful_sources:
        return "degraded"

    if youtube_fail > youtube_success:
        return "degraded"
    if website_fail > website_success:
        return "degraded"

    return "healthy"


def merge_recommendations(youtube_lane: dict[str, Any], website_lane: dict[str, Any]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    website_pages = {
        str(page.get("page_id") or ""): page
        for page in website_lane.get("pages") or []
        if isinstance(page, dict)
    }

    def upsert(source: str, recommendation: dict[str, Any], item_ids: list[str], weight: float) -> None:
        signal_id = str(recommendation.get("id") or "").strip()
        if not signal_id:
            return
        bucket = merged.setdefault(
            signal_id,
            {
                "id": signal_id,
                "title": recommendation.get("title") or signal_id,
                "priority": recommendation.get("priority") or "medium",
                "rationale": recommendation.get("rationale") or "",
                "suggested_paths": list(recommendation.get("suggested_paths") or []),
                "suggested_paths_by_source": {},
                "supporting_item_ids": [],
                "supporting_source_types": [],
                "signal_count": 0,
                "weighted_signal_score": 0.0,
                "source_count": 0,
            },
        )
        bucket["signal_count"] += int(recommendation.get("signal_count") or len(item_ids))
        bucket["weighted_signal_score"] += weight
        for item_id in item_ids:
            if item_id not in bucket["supporting_item_ids"]:
                bucket["supporting_item_ids"].append(item_id)
        if source not in bucket["supporting_source_types"]:
            bucket["supporting_source_types"].append(source)
        bucket["source_count"] = len(bucket["supporting_source_types"])
        source_paths = recommendation.get("suggested_paths_by_source", {}).get(source) if isinstance(recommendation.get("suggested_paths_by_source"), dict) else None
        if source_paths:
            bucket["suggested_paths_by_source"][source] = list(source_paths)
        elif recommendation.get("suggested_paths"):
            bucket["suggested_paths_by_source"][source] = list(recommendation.get("suggested_paths") or [])
        for path in recommendation.get("suggested_paths") or []:
            if path not in bucket["suggested_paths"]:
                bucket["suggested_paths"].append(path)

    for recommendation in youtube_lane.get("recommendations") or []:
        item_ids = list(recommendation.get("supporting_video_ids") or [])
        upsert("youtube", recommendation, item_ids, float(len(item_ids) or 0))

    for recommendation in website_lane.get("recommendations") or []:
        item_ids = list(recommendation.get("supporting_page_ids") or [])
        total_weight = 0.0
        for item_id in item_ids:
            total_weight += float(website_pages.get(item_id, {}).get("importance_score") or website_page_importance(website_pages.get(item_id, {}).get("category")))
        upsert("website", recommendation, item_ids, total_weight)

    recommendations = list(merged.values())
    recommendations.sort(key=lambda item: (-item["source_count"], -item["weighted_signal_score"], -item["signal_count"], item["title"]))
    return recommendations


def preserve_last_good_implementation_lane(output_path: Path, current_lane: dict[str, Any]) -> dict[str, Any]:
    if str(current_lane.get("status") or "").strip().lower() == "healthy":
        return current_lane

    previous_lane = load_last_good_lane(output_path)
    if not previous_lane:
        return current_lane

    if str(previous_lane.get("status") or "").strip().lower() != "healthy":
        return current_lane

    preserved_lane = dict(previous_lane)
    preserved_lane["restored_at"] = iso_now()
    preserved_lane["restored_reason"] = (
        f"Preserved last good unified lane because the latest refresh status was "
        f"{current_lane.get('status') or 'unknown'} while the previous snapshot was healthy."
    )
    preserved_lane["last_attempt"] = {
        "generated_at": current_lane.get("generated_at"),
        "status": current_lane.get("status"),
        "coverage": current_lane.get("coverage"),
    }
    return preserved_lane


def run_doctor(args: argparse.Namespace) -> int:
    youtube = run_child([sys.executable, str(BACKEND_ROOT / "youtube_research_runner.py"), "doctor"], allow_failure=True)
    website = run_child([sys.executable, str(BACKEND_ROOT / "website_research_runner.py"), "doctor"], allow_failure=True)

    youtube_report = json.loads(youtube.stdout or "{}")
    website_report = json.loads(website.stdout or "{}")

    statuses = [youtube_report.get("status"), website_report.get("status")]
    healthy_count = sum(status == "healthy" for status in statuses)
    degraded_count = sum(status == "degraded" for status in statuses)
    if healthy_count == len(statuses):
        status = "healthy"
    elif healthy_count > 0 or degraded_count > 0:
        status = "degraded"
    else:
        status = "unhealthy"

    report = {
        "status": status,
        "checked_at": iso_now(),
        "sources": {
            "youtube": youtube_report,
            "website": website_report,
        },
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if status == "healthy":
        return 0
    if status == "degraded":
        return 2
    return 1


def run(args: argparse.Namespace) -> int:
    output_path = Path(args.output)
    with acquire_lane_lock(output_path):
        return _run_locked(args, output_path)


def _run_locked(args: argparse.Namespace, output_path: Path) -> int:
    if not args.skip_refresh:
        run_child([sys.executable, str(BACKEND_ROOT / "website_research_runner.py")], allow_failure=False)
        run_child([sys.executable, str(BACKEND_ROOT / "youtube_research_runner.py")], allow_failure=False)

    youtube_lane = load_json(Path(args.youtube_output))
    website_lane = load_json(Path(args.website_output))

    coverage = {
        "youtube_video_count": int(youtube_lane.get("total_video_count") or 0),
        "youtube_transcribed_video_count": int(youtube_lane.get("transcribed_video_count") or 0),
        "youtube_failed_video_count": int(youtube_lane.get("failed_video_count") or 0),
        "website_target_count": int(website_lane.get("target_count") or 0),
        "website_page_count": int(website_lane.get("page_count") or len(website_lane.get("pages") or [])),
        "website_discovered_page_count": int(website_lane.get("discovered_page_count") or 0),
        "website_ingested_page_count": int(website_lane.get("ingested_page_count") or 0),
        "website_failed_page_count": int(website_lane.get("failed_page_count") or 0),
    }

    lane = {
        "source_name": "Unified implementation research lane",
        "generated_at": iso_now(),
        "status": compute_status(coverage),
        "importance_legend": website_page_importance_legend(),
        "weighted_score_description": weighted_score_description(),
        "coverage": coverage,
        "recommendations": merge_recommendations(youtube_lane, website_lane),
    }

    lane = preserve_last_good_implementation_lane(output_path, lane)
    if str(lane.get("status") or "").strip().lower() == "healthy":
        save_last_good_lane(output_path, lane)
    write_json_file(output_path, lane)
    print(f"[implementation-lane] wrote {output_path} with {len(lane['recommendations'])} merged recommendations", file=sys.stderr)
    return 0


def main() -> int:
    args = parse_args()
    if args.mode == "doctor":
        return run_doctor(args)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
