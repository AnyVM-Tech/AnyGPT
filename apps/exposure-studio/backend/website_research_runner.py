#!/usr/bin/env python3
"""Website text research runner for SurfaceScope."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import deque
import urllib.request
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse

from lane_shared import (
    acquire_lane_lock,
    SIGNAL_DEFINITIONS,
    env_or_default,
    extract_signals,
    iso_now,
    load_last_good_lane,
    resolve_suggested_paths,
    save_last_good_lane,
    sanitize_text,
    website_page_importance,
    website_page_importance_legend,
    weighted_score_description,
    write_json_file,
)


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGETS_FILE = APP_ROOT / "data" / "research_web_targets.json"
DEFAULT_OUTPUT = APP_ROOT / "data" / ".generated" / "website_implementation_lane.json"
DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_CRAWL_DEPTH = 1
DEFAULT_DISCOVERED_LINK_LIMIT = 10

NON_HTML_SUFFIXES = (
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".webm",
    ".css",
    ".js",
    ".json",
    ".xml",
    ".txt",
)

EXCLUDED_PATH_SEGMENTS = (
    "/feed",
    "/wp-json",
    "/xmlrpc",
    "/wp-admin",
    "/wp-login",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a website text implementation lane.")
    parser.add_argument(
        "mode",
        nargs="?",
        default="run",
        choices=("run", "doctor"),
        help="Use 'doctor' to run preflight diagnostics without building the lane.",
    )
    parser.add_argument("--targets-file", default=env_or_default("WEBSITE_LANE_TARGETS_FILE", str(DEFAULT_TARGETS_FILE)), help="JSON file describing website targets.")
    parser.add_argument("--output", default=env_or_default("WEBSITE_LANE_OUTPUT", str(DEFAULT_OUTPUT)), help="Lane JSON output path.")
    parser.add_argument("--timeout-seconds", type=float, default=float(env_or_default("WEBSITE_LANE_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))), help="HTTP timeout per page.")
    parser.add_argument("--max-pages", type=int, default=int(env_or_default("WEBSITE_LANE_MAX_PAGES", "0")), help="Optional cap for processed pages.")
    parser.add_argument("--crawl-depth", type=int, default=int(env_or_default("WEBSITE_LANE_CRAWL_DEPTH", str(DEFAULT_CRAWL_DEPTH))), help="How many same-origin link levels to follow from seed pages.")
    parser.add_argument("--discovered-links-per-page", type=int, default=int(env_or_default("WEBSITE_LANE_DISCOVERED_LINKS_PER_PAGE", str(DEFAULT_DISCOVERED_LINK_LIMIT))), help="Cap discovered same-origin links per fetched page.")
    return parser.parse_args()


def load_targets(path: Path) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{path} must contain a JSON list")
    return [item for item in raw if isinstance(item, dict) and str(item.get("url") or "").startswith("https://")]


def strip_html_to_text(body: str) -> str:
    cleaned = re.sub(r"(?is)<script\b.*?</script>", " ", body)
    cleaned = re.sub(r"(?is)<style\b.*?</style>", " ", cleaned)
    cleaned = re.sub(r"(?is)<noscript\b.*?</noscript>", " ", cleaned)
    cleaned = re.sub(r"(?is)<svg\b.*?</svg>", " ", cleaned)
    cleaned = re.sub(r"(?is)<[^>]+>", " ", cleaned)
    return sanitize_text(unescape(cleaned))


def extract_title(body: str) -> str:
    match = re.search(r"(?is)<title>(.*?)</title>", body)
    return sanitize_text(unescape(match.group(1))) if match else ""


def fetch_page(url: str, timeout_seconds: float) -> tuple[dict[str, Any], str]:
    request = urllib.request.Request(url, headers={"User-Agent": "SurfaceScope/0.1 website-research-lane"})
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8", "replace")
        metadata = {
            "final_url": response.geturl(),
            "http_status": getattr(response, "status", 200),
            "content_type": response.headers.get("content-type", ""),
    }
    return metadata, body


def normalize_candidate_url(raw_url: str, base_url: str, allowed_hosts: set[str]) -> str | None:
    if not raw_url:
        return None
    joined = urljoin(base_url, raw_url.strip())
    without_fragment, _ = urldefrag(joined)
    parsed = urlparse(without_fragment)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.netloc or parsed.netloc not in allowed_hosts:
        return None
    lowered_path = parsed.path.lower()
    if lowered_path.endswith(NON_HTML_SUFFIXES):
        return None
    stripped_segments = {segment.strip("/") for segment in EXCLUDED_PATH_SEGMENTS}
    path_segments = [segment for segment in lowered_path.strip("/").split("/") if segment]
    if any(segment in stripped_segments for segment in path_segments):
        return None
    if any(lowered_path == segment or lowered_path.startswith(segment) for segment in EXCLUDED_PATH_SEGMENTS):
        return None
    normalized = parsed._replace(query="", fragment="")
    return normalized.geturl()


def extract_internal_links(body: str, base_url: str, allowed_hosts: set[str], limit: int) -> list[str]:
    seen: list[str] = []
    for match in re.finditer(r"""href\s*=\s*["']([^"']+)["']""", body, flags=re.IGNORECASE):
        normalized = normalize_candidate_url(match.group(1), base_url, allowed_hosts)
        if not normalized or normalized in seen:
            continue
        seen.append(normalized)
        if limit > 0 and len(seen) >= limit:
            break
    return seen


def build_page_id(url: str, fallback: str) -> str:
    parsed = urlparse(url)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{parsed.netloc}{parsed.path}".lower()).strip("-")
    if not slug:
        return fallback
    return f"page-{slug[:72]}"


def build_recommendations(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    definitions = {definition.id: definition for definition in SIGNAL_DEFINITIONS}
    grouped: dict[str, list[str]] = {}
    page_index = {
        str(page.get("page_id") or ""): page
        for page in pages
        if isinstance(page, dict)
    }
    for page in pages:
        for signal_id in page.get("implementation_signals", []):
            grouped.setdefault(signal_id, []).append(page["page_id"])

    recommendations: list[dict[str, Any]] = []
    for signal_id, page_ids in grouped.items():
        definition = definitions.get(signal_id)
        if not definition:
            continue
        suggested_paths = resolve_suggested_paths(definition, "website")
        weighted_signal_score = sum(
            float(page_index.get(page_id, {}).get("importance_score") or 0.0)
            for page_id in page_ids
        )
        recommendations.append(
            {
                "id": definition.id,
                "title": definition.title,
                "priority": definition.priority,
                "rationale": definition.rationale,
                "suggested_paths": suggested_paths,
                "suggested_paths_by_source": {
                    "website": suggested_paths,
                },
                "supporting_source_types": ["website"],
                "supporting_page_ids": page_ids,
                "signal_count": len(page_ids),
                "weighted_signal_score": weighted_signal_score,
                "source_count": 1,
            }
        )

    recommendations.sort(key=lambda item: (-item["weighted_signal_score"], -item["signal_count"], item["title"]))
    return recommendations


def preserve_last_good_website_lane(output_path: Path, current_lane: dict[str, Any]) -> dict[str, Any]:
    current_success = int(current_lane.get("ingested_page_count") or 0)
    if current_success > 0:
        return current_lane

    previous_lane = load_last_good_lane(output_path)
    if not previous_lane:
        return current_lane

    previous_success = int(previous_lane.get("ingested_page_count") or 0)
    if previous_success <= current_success:
        return current_lane

    preserved_lane = dict(previous_lane)
    preserved_lane["restored_at"] = iso_now()
    preserved_lane["restored_reason"] = (
        f"Preserved last good website lane because the latest refresh produced "
        f"{current_success} ingested pages and the previous snapshot had {previous_success}."
    )
    preserved_lane["last_attempt"] = {
        "generated_at": current_lane.get("generated_at"),
        "target_count": current_lane.get("target_count"),
        "page_count": current_lane.get("page_count"),
        "ingested_page_count": current_lane.get("ingested_page_count"),
        "failed_page_count": current_lane.get("failed_page_count"),
    }
    return preserved_lane


def run_doctor(args: argparse.Namespace) -> int:
    targets_path = Path(args.targets_file)
    checks: list[dict[str, Any]] = []

    def add_check(name: str, ok: bool, detail: str, level: str = "info") -> None:
        checks.append({"name": name, "ok": ok, "level": level, "detail": detail})

    add_check("targets_file", targets_path.exists() and targets_path.is_file(), f"Using targets file {targets_path}", level="error" if not targets_path.exists() else "info")

    targets: list[dict[str, Any]] = []
    if targets_path.exists():
        try:
            targets = load_targets(targets_path)
            add_check("target_count", len(targets) > 0, f"Loaded {len(targets)} website targets.", level="error" if not targets else "info")
        except Exception as error:
            add_check("target_count", False, str(error), level="error")

    if targets:
        sample = targets[0]
        try:
            metadata, body = fetch_page(sample["url"], args.timeout_seconds)
            body_text = strip_html_to_text(body)
            add_check("page_fetch", True, f"{sample['url']} returned {metadata['http_status']} with {len(body_text.split())} words.")
            allowed_hosts = {urlparse(str(target.get("url") or "")).netloc for target in targets if str(target.get("url") or "").startswith("https://")}
            discovered = extract_internal_links(body, metadata["final_url"], allowed_hosts, args.discovered_links_per_page)
            add_check("internal_link_discovery", len(discovered) > 0, f"Discovered {len(discovered)} same-origin links from the sample page.", level="warning" if not discovered else "info")
        except Exception as error:
            add_check("page_fetch", False, str(error), level="error")

    status = "healthy"
    if any(not check["ok"] and check["level"] == "error" for check in checks):
        status = "unhealthy"
    elif any(not check["ok"] and check["level"] == "warning" for check in checks):
        status = "degraded"

    print(json.dumps({"status": status, "checked_at": iso_now(), "targets_file": str(targets_path), "checks": checks}, indent=2, ensure_ascii=False))
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
    targets = load_targets(Path(args.targets_file))
    allowed_hosts = {
        urlparse(str(target.get("url") or "").strip()).netloc
        for target in targets
        if str(target.get("url") or "").startswith("https://")
    }

    pages: list[dict[str, Any]] = []
    queue: deque[dict[str, Any]] = deque()
    seen_urls: set[str] = set()

    for index, target in enumerate(targets, start=1):
        url = str(target.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        queue.append(
            {
                "page_id": str(target.get("id") or f"seed-{index}"),
                "title": sanitize_text(str(target.get("title") or "")),
                "url": url,
                "category": sanitize_text(str(target.get("category") or "")),
                "crawl_depth": 0,
                "discovered_from_page_id": "",
                "seed_target_id": str(target.get("id") or f"seed-{index}"),
            }
        )

    processed = 0
    while queue:
        if args.max_pages > 0 and processed >= args.max_pages:
            break

        target = queue.popleft()
        processed += 1
        page_id = str(target.get("page_id") or build_page_id(str(target.get("url") or ""), f"page-{processed}"))
        title = sanitize_text(str(target.get("title") or ""))
        url = str(target.get("url") or "").strip()
        category = sanitize_text(str(target.get("category") or ""))
        crawl_depth = int(target.get("crawl_depth") or 0)
        discovered_from_page_id = sanitize_text(str(target.get("discovered_from_page_id") or ""))
        seed_target_id = sanitize_text(str(target.get("seed_target_id") or page_id))
        print(f"[website-lane] {processed} fetching {url} (depth {crawl_depth})", file=sys.stderr)

        fetch_status = "failed"
        http_status = None
        final_url = ""
        text_word_count = 0
        implementation_signals: list[str] = []
        implementation_notes: list[str] = []
        evidence_snippets: list[str] = []
        page_excerpt = ""
        error_summary = ""

        try:
            metadata, body = fetch_page(url, args.timeout_seconds)
            final_url = metadata["final_url"]
            http_status = metadata["http_status"]

            # Post-redirect host validation: reject body if the final URL
            # landed on a host outside the configured allowlist.
            final_host = urlparse(final_url).netloc if final_url else ""
            if final_host and final_host not in allowed_hosts:
                fetch_status = "failed"
                error_summary = f"Redirect landed on out-of-scope host {final_host} (from {url})."
                pages.append(
                    {
                        "page_id": page_id,
                        "title": title,
                        "url": url,
                        "category": category,
                        "fetch_status": fetch_status,
                        "final_url": final_url,
                "http_status": http_status,
                "text_word_count": 0,
                "importance_score": website_page_importance(category),
                "implementation_signals": [],
                "implementation_notes": [],
                "evidence_snippets": [],
                        "page_excerpt": "",
                        "error_summary": error_summary,
                        "crawl_depth": crawl_depth,
                        "discovered_from_page_id": discovered_from_page_id,
                        "seed_target_id": seed_target_id,
                    }
                )
                continue

            fetch_status = "ok" if metadata["http_status"] == 200 else "reachable_with_error"
            extracted_title = extract_title(body)
            if extracted_title:
                title = extracted_title
            body_text = strip_html_to_text(body)
            text_word_count = len(body_text.split())
            if body_text:
                effective_url = final_url or url
                implementation_signals, implementation_notes, evidence_snippets = extract_signals(body_text, page_url=effective_url)
                page_excerpt = body_text[:320]
                if crawl_depth < max(0, args.crawl_depth):
                    for discovered_url in extract_internal_links(body, final_url or url, allowed_hosts, args.discovered_links_per_page):
                        if discovered_url in seen_urls:
                            continue
                        seen_urls.add(discovered_url)
                        queue.append(
                            {
                                "page_id": build_page_id(discovered_url, f"page-{len(seen_urls)}"),
                                "title": "",
                                "url": discovered_url,
                                "category": "discovered_internal_link",
                                "crawl_depth": crawl_depth + 1,
                                "discovered_from_page_id": page_id,
                                "seed_target_id": seed_target_id,
                            }
                        )
            else:
                fetch_status = "failed"
                error_summary = "No usable body text was extracted from the page."
        except Exception as error:
            error_summary = str(error)

        pages.append(
            {
                "page_id": page_id,
                "title": title,
                "url": url,
                "category": category,
                "fetch_status": fetch_status,
                "final_url": final_url,
                "http_status": http_status,
                "text_word_count": text_word_count,
                "importance_score": website_page_importance(category),
                "implementation_signals": implementation_signals,
                "implementation_notes": implementation_notes,
                "evidence_snippets": evidence_snippets,
                "page_excerpt": page_excerpt,
                "error_summary": error_summary,
                "crawl_depth": crawl_depth,
                "discovered_from_page_id": discovered_from_page_id,
                "seed_target_id": seed_target_id,
            }
        )

    lane = {
        "source_name": "Website text research lane",
        "generated_at": iso_now(),
        "importance_legend": website_page_importance_legend(),
        "weighted_score_description": weighted_score_description(),
        "target_count": len(targets),
        "page_count": len(pages),
        "discovered_page_count": sum(1 for page in pages if page.get("discovered_from_page_id")),
        "ingested_page_count": sum(1 for page in pages if page["fetch_status"] == "ok"),
        "failed_page_count": sum(1 for page in pages if page["fetch_status"] != "ok"),
        "recommendations": build_recommendations(pages),
        "pages": pages,
    }

    lane = preserve_last_good_website_lane(output_path, lane)
    if int(lane.get("ingested_page_count") or 0) > 0:
        save_last_good_lane(output_path, lane)
    write_json_file(output_path, lane)
    print(f"[website-lane] wrote {output_path} with {lane['ingested_page_count']} fetched website documents", file=sys.stderr)
    return 0


def main() -> int:
    args = parse_args()
    if args.mode == "doctor":
        return run_doctor(args)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
