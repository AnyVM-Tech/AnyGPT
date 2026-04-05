#!/usr/bin/env python3
"""Transcript-first YouTube research runner for SurfaceScope.

This lane intentionally derives implementation signals only from speech-to-text
transcripts. Video titles and descriptions are kept as metadata for operator
review, but they are not used as fallback extraction sources.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from collections import defaultdict
from importlib.metadata import version as package_version
from importlib.metadata import PackageNotFoundError
from pathlib import Path
from typing import Any

from lane_shared import (
    acquire_lane_lock,
    SIGNAL_DEFINITIONS,
    SignalDefinition,
    env_or_default,
    extract_signals,
    iso_now,
    load_last_good_lane,
    read_json_file,
    resolve_suggested_paths,
    save_last_good_lane,
    sanitize_text,
    split_sentences,
    write_json_file,
)

try:
    from faster_whisper import WhisperModel
except ImportError as error:  # pragma: no cover - import guard
    raise SystemExit(
        "faster-whisper is required. Install backend/requirements-youtube-research.txt first."
    ) from error

try:
    from yt_dlp import YoutubeDL
except ImportError as error:  # pragma: no cover - import guard
    raise SystemExit(
        "yt-dlp is required. Install backend/requirements-youtube-research.txt first."
    ) from error

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api.formatters import TextFormatter
except ImportError:  # pragma: no cover - optional fallback
    YouTubeTranscriptApi = None
    TextFormatter = None


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CHANNEL_URL = "https://www.youtube.com/@TheAIAutomators/videos"
DEFAULT_GENERATED_DIR = APP_ROOT / "data" / ".generated"
DEFAULT_OUTPUT = DEFAULT_GENERATED_DIR / "youtube_implementation_lane.json"
DEFAULT_CACHE_DIR = DEFAULT_GENERATED_DIR / "youtube-cache"
DEFAULT_COOKIES_BROWSER = ""
DEFAULT_COOKIES_PROFILE = ""
DEFAULT_COOKIES_KEYRING = ""
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BACKOFF_SECONDS = 5.0

BROWSER_COOKIE_CANDIDATES = (
    ("chrome", Path("~/.config/google-chrome").expanduser(), "Cookies"),
    ("chromium", Path("~/.config/chromium").expanduser(), "Cookies"),
    ("brave", Path("~/.config/BraveSoftware/Brave-Browser").expanduser(), "Cookies"),
    ("firefox", Path("~/.mozilla/firefox").expanduser(), "cookies.sqlite"),
)



# iso_now, env_or_default, sanitize_text, split_sentences, extract_signals,
# SIGNAL_DEFINITIONS, and SignalDefinition are imported from lane_shared.


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a transcript-first YouTube implementation lane.")
    parser.add_argument(
        "mode",
        nargs="?",
        default="run",
        choices=("run", "doctor"),
        help="Use 'doctor' to run preflight diagnostics without building the lane.",
    )
    parser.add_argument("--channel-url", default=env_or_default("YOUTUBE_LANE_CHANNEL_URL", DEFAULT_CHANNEL_URL), help="YouTube channel videos URL.")
    parser.add_argument("--output", default=env_or_default("YOUTUBE_LANE_OUTPUT", str(DEFAULT_OUTPUT)), help="Lane JSON output path.")
    parser.add_argument("--cache-dir", default=env_or_default("YOUTUBE_LANE_CACHE_DIR", str(DEFAULT_CACHE_DIR)), help="Cache directory for transcripts and temporary audio.")
    parser.add_argument("--model", default=env_or_default("YOUTUBE_LANE_MODEL", "small"), help="faster-whisper model name (for example: tiny, small, medium).")
    parser.add_argument("--device", default=env_or_default("YOUTUBE_LANE_DEVICE", "auto"), help="Whisper device selection.")
    parser.add_argument("--compute-type", default=env_or_default("YOUTUBE_LANE_COMPUTE_TYPE", "int8"), help="Whisper compute type.")
    parser.add_argument("--max-videos", type=int, default=int(env_or_default("YOUTUBE_LANE_MAX_VIDEOS", "0")), help="Optional cap for video processing.")
    parser.add_argument("--sleep-seconds", type=float, default=float(env_or_default("YOUTUBE_LANE_SLEEP_SECONDS", "0")), help="Optional delay between downloads.")
    parser.add_argument("--retry-attempts", type=int, default=int(env_or_default("YOUTUBE_LANE_RETRY_ATTEMPTS", str(DEFAULT_RETRY_ATTEMPTS))), help="Retry attempts for transient YouTube download failures.")
    parser.add_argument("--retry-backoff-seconds", type=float, default=float(env_or_default("YOUTUBE_LANE_RETRY_BACKOFF_SECONDS", str(DEFAULT_RETRY_BACKOFF_SECONDS))), help="Base backoff in seconds between YouTube retries.")
    parser.add_argument("--keep-audio", action="store_true", help="Keep downloaded audio files in cache.")
    parser.add_argument("--cookies-file", default=env_or_default("YOUTUBE_LANE_COOKIES_FILE", ""), help="Optional Netscape cookies file for yt-dlp.")
    parser.add_argument("--cookies-browser", default=env_or_default("YOUTUBE_LANE_COOKIES_BROWSER", DEFAULT_COOKIES_BROWSER), help="Optional browser name for yt-dlp cookies-from-browser.")
    parser.add_argument("--cookies-browser-profile", default=env_or_default("YOUTUBE_LANE_COOKIES_PROFILE", DEFAULT_COOKIES_PROFILE), help="Optional browser profile path/name for cookies-from-browser.")
    parser.add_argument("--cookies-browser-keyring", default=env_or_default("YOUTUBE_LANE_COOKIES_KEYRING", DEFAULT_COOKIES_KEYRING), help="Optional keyring selector for cookies-from-browser.")
    parser.add_argument("--proxy", default=env_or_default("YOUTUBE_LANE_PROXY", ""), help="Optional outbound proxy URL for yt-dlp.")
    return parser.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> Any | None:
    return read_json_file(path)


def write_json(path: Path, payload: Any) -> None:
    write_json_file(path, payload)


def build_js_runtime_config() -> dict[str, dict[str, str]]:
    if shutil.which("node"):
        return {"node": {}}
    return {}


def find_browser_cookie_source() -> dict[str, str]:
    for browser_name, root_dir, cookie_filename in BROWSER_COOKIE_CANDIDATES:
        if not root_dir.exists():
            continue
        for cookie_path in root_dir.rglob(cookie_filename):
            return {
                "mode": "browser",
                "browser": browser_name,
                "profile": str(cookie_path.parent),
                "keyring": "",
            }
    return {"mode": "none", "browser": "", "profile": "", "keyring": ""}


def resolve_cookie_source(args: argparse.Namespace) -> dict[str, str]:
    cookies_file = args.cookies_file.strip()
    if cookies_file:
        return {
            "mode": "file",
            "browser": "",
            "profile": cookies_file,
            "keyring": "",
        }

    cookies_browser = args.cookies_browser.strip()
    cookies_profile = args.cookies_browser_profile.strip()
    cookies_keyring = args.cookies_browser_keyring.strip()
    if cookies_browser:
        return {
            "mode": "browser",
            "browser": cookies_browser,
            "profile": cookies_profile,
            "keyring": cookies_keyring,
        }

    return find_browser_cookie_source()


def build_ydl_options(base: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    options = dict(base)
    cookie_source = resolve_cookie_source(args)
    if cookie_source["mode"] == "file":
        options["cookiefile"] = cookie_source["profile"]
    elif cookie_source["mode"] == "browser":
        options["cookiesfrombrowser"] = (
            cookie_source["browser"],
            cookie_source["profile"] or None,
            cookie_source["keyring"] or None,
            None,
        )

    if args.proxy:
        options["proxy"] = args.proxy

    js_runtimes = build_js_runtime_config()
    if js_runtimes:
        options["js_runtimes"] = js_runtimes

    return options


def print_runtime_summary(args: argparse.Namespace) -> None:
    cookie_source = resolve_cookie_source(args)
    runtime = {
        "mode": args.mode,
        "channel_url": args.channel_url,
        "output": str(Path(args.output)),
        "cache_dir": str(Path(args.cache_dir)),
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "max_videos": args.max_videos,
        "retry_attempts": args.retry_attempts,
        "retry_backoff_seconds": args.retry_backoff_seconds,
        "cookies_file_configured": bool(args.cookies_file),
        "cookies_browser_configured": bool(args.cookies_browser),
        "cookies_browser_profile_configured": bool(args.cookies_browser_profile),
        "cookie_source_mode": cookie_source["mode"],
        "cookie_source_browser": cookie_source["browser"],
        "proxy_configured": bool(args.proxy),
        "js_runtime_node_available": bool(shutil.which("node")),
    }
    print(f"[youtube-lane] runtime {json.dumps(runtime, ensure_ascii=False)}", file=sys.stderr)


def installed_package_version(name: str) -> str:
    try:
        return package_version(name)
    except PackageNotFoundError:
        return ""



# sanitize_text, split_sentences, and extract_signals are imported from lane_shared.


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return ""
    hours, remainder = divmod(int(seconds), 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def to_iso_date(upload_date: str | None) -> str:
    if not upload_date or len(upload_date) != 8 or not upload_date.isdigit():
        return ""
    return f"{upload_date[0:4]}-{upload_date[4:6]}-{upload_date[6:8]}"


def load_cached_transcript(cache_path: Path, model_name: str) -> dict[str, Any] | None:
    cached = load_json(cache_path)
    if not isinstance(cached, dict) or cached.get("transcript_status") != "complete":
        return None
    source = str(cached.get("transcript_source") or "")
    if source == "youtube_auto_captions":
        return cached
    if cached.get("model_name") == model_name:
        return cached
    return None


def load_any_complete_transcript(cache_path: Path) -> dict[str, Any] | None:
    cached = load_json(cache_path)
    if not isinstance(cached, dict):
        return None
    if cached.get("transcript_status") != "complete":
        return None
    return cached


def is_retryable_youtube_error(error: Exception | str) -> bool:
    message = str(error or "").lower()
    retry_markers = (
        "http error 403",
        "unable to download video data",
        "sign in to confirm you're not a bot",
        "sign in to confirm you’re not a bot",
        "timed out",
        "timeout",
        "connection reset",
        "temporarily unavailable",
        "remote end closed connection",
        "proxy",
    )
    return any(marker in message for marker in retry_markers)


def run_with_retry(task_label: str, operation, *, attempts: int, backoff_seconds: float):
    last_error: Exception | None = None
    total_attempts = max(1, attempts)
    total_backoff = 0.0
    for attempt in range(1, total_attempts + 1):
        try:
            return operation(), {
                "attempt_count": attempt,
                "backoff_seconds": total_backoff,
                "recovered_after_retry": attempt > 1,
            }
        except Exception as error:  # pragma: no cover - network-dependent path
            last_error = error
            if attempt >= total_attempts or not is_retryable_youtube_error(error):
                raise
            delay = max(0.0, backoff_seconds) * (2 ** (attempt - 1))
            total_backoff += delay
            print(
                f"[youtube-lane] retrying {task_label} after attempt {attempt}/{total_attempts}: {error}",
                file=sys.stderr,
            )
            if delay > 0:
                time.sleep(delay)
    if last_error:
        raise last_error
    raise RuntimeError(f"{task_label} failed without an exception")


def list_channel_entries(channel_url: str, args: argparse.Namespace) -> tuple[str, str, list[dict[str, Any]]]:
    options = build_ydl_options({
        "quiet": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlistend": args.max_videos or None,
        "ignoreerrors": True,
        "noplaylist": False,
    }, args)
    with YoutubeDL(options) as ydl:
        payload = ydl.extract_info(channel_url, download=False)

    entries = [
        entry
        for entry in (payload.get("entries") or [])
        if isinstance(entry, dict) and entry.get("id")
    ]
    channel_title = payload.get("title") or "Unknown channel"
    channel_id = payload.get("channel_id") or payload.get("id") or ""
    return channel_title, channel_id, entries


def build_processing_plan(entries: list[dict[str, Any]], transcript_dir: Path) -> list[dict[str, Any]]:
    seen_video_ids: set[str] = set()
    cached_entries: list[dict[str, Any]] = []
    uncached_entries: list[dict[str, Any]] = []

    for original_index, entry in enumerate(entries):
        video_id = str(entry.get("id") or "").strip()
        if not video_id or video_id in seen_video_ids:
            continue
        seen_video_ids.add(video_id)

        plan_item = {
            "entry": entry,
            "original_index": original_index,
            "video_id": video_id,
            "duration_seconds": int(entry.get("duration")) if isinstance(entry.get("duration"), (int, float)) else None,
        }
        transcript_cache = transcript_dir / f"{video_id}.json"
        if load_any_complete_transcript(transcript_cache):
            cached_entries.append(plan_item)
        else:
            uncached_entries.append(plan_item)

    uncached_entries.sort(
        key=lambda item: (
            item["duration_seconds"] is None,
            item["duration_seconds"] or 0,
            item["original_index"],
        )
    )
    return cached_entries + uncached_entries


def probe_audio_access(video_url: str, args: argparse.Namespace) -> tuple[bool, str]:
    options = build_ydl_options({
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "ignoreerrors": False,
    }, args)
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(video_url, download=False)
        title = sanitize_text(str((info or {}).get("title") or ""))
        return True, title or "audio metadata accessible"
    except Exception as error:  # pragma: no cover - network-dependent
        return False, str(error)


def find_cached_audio(audio_dir: Path, video_id: str) -> Path | None:
    matches = sorted(audio_dir.glob(f"{video_id}.*"))
    return matches[0] if matches else None


def download_audio(video_url: str, video_id: str, audio_dir: Path, args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    ensure_dir(audio_dir)
    cached = find_cached_audio(audio_dir, video_id)
    if cached:
        return cached, {}

    options = build_ydl_options({
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "outtmpl": str(audio_dir / f"{video_id}.%(ext)s"),
        "restrictfilenames": True,
        "ignoreerrors": False,
    }, args)
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(video_url, download=True)

    requested_downloads = info.get("requested_downloads") or []
    file_path = None
    if requested_downloads:
        file_path = requested_downloads[0].get("filepath")
    if not file_path:
        file_path = ydl.prepare_filename(info)
    return Path(file_path), info


def transcribe_audio(
    model: WhisperModel,
    audio_path: Path,
    cache_path: Path,
    model_name: str,
    acquisition_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cached = load_cached_transcript(cache_path, model_name)
    if cached:
        return cached

    segments, info = model.transcribe(
        str(audio_path),
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    transcript_parts: list[str] = []
    for segment in segments:
        text = sanitize_text(segment.text)
        if text:
            transcript_parts.append(text)

    transcript_text = sanitize_text(" ".join(transcript_parts))
    payload = {
        "model_name": model_name,
        "transcript_source": "faster_whisper",
        "transcript_status": "complete" if transcript_text else "failed",
        "transcript_language": getattr(info, "language", "") or "",
        "transcript_text": transcript_text,
        "acquisition_retry_attempt_count": int((acquisition_meta or {}).get("attempt_count") or 1),
        "acquisition_retry_backoff_seconds": float((acquisition_meta or {}).get("backoff_seconds") or 0.0),
        "acquisition_retry_recovered": bool((acquisition_meta or {}).get("recovered_after_retry")),
        "generated_at": iso_now(),
    }
    write_json(cache_path, payload)
    return payload


def fetch_auto_captions(video_id: str, cache_path: Path) -> dict[str, Any]:
    cached = load_cached_transcript(cache_path, "")
    if cached and cached.get("transcript_source") == "youtube_auto_captions":
        return cached
    if YouTubeTranscriptApi is None or TextFormatter is None:
        raise RuntimeError("youtube-transcript-api is not installed.")

    transcript = YouTubeTranscriptApi().fetch(video_id, languages=["en", "de"])
    transcript_text = sanitize_text(TextFormatter().format_transcript(transcript))
    payload = {
        "model_name": "",
        "transcript_source": "youtube_auto_captions",
        "transcript_status": "complete" if transcript_text else "failed",
        "transcript_language": getattr(transcript, "language_code", "") or "",
        "transcript_text": transcript_text,
        "acquisition_retry_attempt_count": 0,
        "acquisition_retry_backoff_seconds": 0.0,
        "acquisition_retry_recovered": False,
        "generated_at": iso_now(),
    }
    write_json(cache_path, payload)
    return payload


def probe_auto_captions(video_id: str) -> tuple[bool, str]:
    if YouTubeTranscriptApi is None or TextFormatter is None:
        return False, "youtube-transcript-api is not installed."
    try:
        transcript = YouTubeTranscriptApi().fetch(video_id, languages=["en", "de"])
        transcript_text = sanitize_text(TextFormatter().format_transcript(transcript))
        if not transcript_text:
            return False, "Transcript request returned an empty payload."
        return True, f"{len(transcript_text.split())} words"
    except Exception as error:  # pragma: no cover - network-dependent
        return False, str(error)


def empty_lane(channel_url: str) -> dict[str, Any]:
    return {
        "source_name": "YouTube transcript research lane",
        "channel_title": "The AI Automators",
        "channel_id": "",
        "channel_url": channel_url,
        "generated_at": "",
        "model_name": "",
        "total_video_count": 0,
            "transcribed_video_count": 0,
            "failed_video_count": 0,
            "recommendations": [],
            "videos": [],
    }


def build_recommendations(videos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    supporting_ids: dict[str, list[str]] = defaultdict(list)
    for video in videos:
        for signal_id in video["implementation_signals"]:
            supporting_ids[signal_id].append(video["video_id"])

    recommendations: list[dict[str, Any]] = []
    for definition in SIGNAL_DEFINITIONS:
        ids = supporting_ids.get(definition.id, [])
        if not ids:
            continue
        count = len(ids)
        suggested_paths = resolve_suggested_paths(definition, "youtube")
        recommendations.append(
            {
                "id": definition.id,
                "title": definition.title,
                "priority": definition.priority,
                "rationale": definition.rationale,
                "suggested_paths": suggested_paths,
                "suggested_paths_by_source": {
                    "youtube": suggested_paths,
                },
                "supporting_video_ids": ids,
                "supporting_source_types": ["youtube"],
                "signal_count": count,
                "weighted_signal_score": float(count),
                "source_count": 1,
            }
        )

    recommendations.sort(key=lambda item: (-item["signal_count"], item["title"]))
    return recommendations


def preserve_last_good_youtube_lane(output_path: Path, current_lane: dict[str, Any]) -> dict[str, Any]:
    current_success = int(current_lane.get("transcribed_video_count") or 0)
    if current_success > 0:
        return current_lane

    previous_lane = load_last_good_lane(output_path)
    if not previous_lane:
        return current_lane

    previous_success = int(previous_lane.get("transcribed_video_count") or 0)
    if previous_success <= current_success:
        return current_lane

    preserved_lane = dict(previous_lane)
    preserved_lane["restored_at"] = iso_now()
    preserved_lane["restored_reason"] = (
        f"Preserved last good YouTube lane because the latest refresh produced "
        f"{current_success} transcript-backed videos and the previous snapshot had {previous_success}."
    )
    preserved_lane["last_attempt"] = {
        "generated_at": current_lane.get("generated_at"),
        "total_video_count": current_lane.get("total_video_count"),
        "transcribed_video_count": current_lane.get("transcribed_video_count"),
        "failed_video_count": current_lane.get("failed_video_count"),
    }
    return preserved_lane


def build_doctor_report(args: argparse.Namespace) -> dict[str, Any]:
    cache_dir = Path(args.cache_dir)
    ensure_dir(cache_dir)

    checks: list[dict[str, Any]] = []

    def add_check(name: str, ok: bool, detail: str, level: str = "info") -> None:
        checks.append({
            "name": name,
            "ok": ok,
            "level": level,
            "detail": detail,
        })

    package_versions = {
        "yt_dlp": installed_package_version("yt-dlp"),
        "faster_whisper": installed_package_version("faster-whisper"),
        "youtube_transcript_api": installed_package_version("youtube-transcript-api"),
    }

    add_check(
        "cache_dir",
        cache_dir.exists() and cache_dir.is_dir(),
        f"Using cache dir {cache_dir}",
    )

    cookie_source = resolve_cookie_source(args)
    if cookie_source["mode"] == "file":
        cookie_path = Path(cookie_source["profile"])
        add_check(
            "cookies_file",
            cookie_path.exists() and cookie_path.is_file(),
            f"Configured cookies file: {cookie_path}",
            level="warning" if not (cookie_path.exists() and cookie_path.is_file()) else "info",
        )
    elif cookie_source["mode"] == "browser":
        profile_hint = cookie_source["profile"] or "<default>"
        add_check(
            "cookies_browser",
            True,
            f"Using browser cookies from {cookie_source['browser']} profile {profile_hint}",
        )
    else:
        add_check(
            "cookies_source",
            False,
            "No cookies source configured or auto-detected. This is often why YouTube transcript/audio access is blocked on cloud IPs.",
            level="warning",
        )

    if args.proxy.strip():
        add_check("proxy", True, f"Proxy configured: {args.proxy}")
    else:
        add_check(
            "proxy",
            False,
            "No proxy configured.",
            level="warning",
        )

    channel_title = ""
    channel_id = ""
    entries: list[dict[str, Any]] = []
    try:
        channel_title, channel_id, entries = list_channel_entries(
            args.channel_url,
            argparse.Namespace(**{**vars(args), "max_videos": max(1, args.max_videos)}),
        )
        add_check(
            "channel_listing",
            len(entries) > 0,
            f"Resolved channel '{channel_title}' ({channel_id}) with {len(entries)} visible entries.",
            level="error" if not entries else "info",
        )
    except Exception as error:  # pragma: no cover - network-dependent
        add_check("channel_listing", False, str(error), level="error")

    sample_videos = entries[: min(3, len(entries))]
    if sample_videos:
        audio_successes = 0
        audio_failures: list[str] = []
        captions_successes = 0
        captions_failures: list[str] = []

        for entry in sample_videos:
            video_id = str(entry.get("id") or "").strip()
            video_url = entry.get("url")
            if not isinstance(video_url, str) or not video_url:
                video_url = f"https://www.youtube.com/watch?v={video_id}"

            audio_ok, audio_detail = probe_audio_access(video_url, args)
            if audio_ok:
                audio_successes += 1
            else:
                audio_failures.append(f"{video_id}: {audio_detail}")

            captions_ok, captions_detail = probe_auto_captions(video_id)
            if captions_ok:
                captions_successes += 1
            else:
                captions_failures.append(f"{video_id}: {captions_detail}")

        add_check(
            "audio_access",
            audio_successes == len(sample_videos),
            f"Audio access succeeded for {audio_successes}/{len(sample_videos)} sampled videos."
            + (f" Failures: {' | '.join(audio_failures[:2])}" if audio_failures else ""),
            level="error" if audio_successes == 0 else ("warning" if audio_successes < len(sample_videos) else "info"),
        )

        add_check(
            "auto_captions",
            captions_successes == len(sample_videos),
            f"Auto captions succeeded for {captions_successes}/{len(sample_videos)} sampled videos."
            + (f" Failures: {' | '.join(captions_failures[:2])}" if captions_failures else ""),
            level="info" if audio_successes > 0 else ("warning" if captions_successes < len(sample_videos) else "info"),
        )
    else:
        add_check(
            "sample_videos",
            False,
            "No sample video available for transcript diagnostics.",
            level="error",
        )

    hard_failures = [check for check in checks if check["level"] == "error" and not check["ok"]]
    warnings = [check for check in checks if check["level"] == "warning" and not check["ok"]]
    if hard_failures:
        status = "unhealthy"
    elif warnings:
        status = "degraded"
    else:
        status = "healthy"

    return {
        "status": status,
        "checked_at": iso_now(),
        "channel_url": args.channel_url,
        "package_versions": package_versions,
        "checks": checks,
    }


def main() -> int:
    args = parse_args()
    print_runtime_summary(args)

    if args.mode == "doctor":
        report = build_doctor_report(args)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        if report["status"] == "healthy":
            return 0
        if report["status"] == "degraded":
            return 2
        return 1

    output_path = Path(args.output)
    with acquire_lane_lock(output_path):
        return _run_locked(args, output_path)

def _run_locked(args: argparse.Namespace, output_path: Path) -> int:
    cache_dir = Path(args.cache_dir)
    audio_dir = cache_dir / "audio"
    transcript_dir = cache_dir / "transcripts"
    ensure_dir(audio_dir)
    ensure_dir(transcript_dir)

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    channel_title, channel_id, entries = list_channel_entries(
        args.channel_url,
        args,
    )
    processing_plan = build_processing_plan(entries, transcript_dir)

    lane = empty_lane(args.channel_url)
    lane["channel_title"] = channel_title
    lane["channel_id"] = channel_id
    lane["generated_at"] = iso_now()
    lane["model_name"] = args.model
    lane["total_video_count"] = len(processing_plan)

    videos: list[dict[str, Any]] = []
    failures = 0

    for index, plan_item in enumerate(processing_plan, start=1):
        entry = plan_item["entry"]
        video_id = str(plan_item["video_id"] or "").strip()
        if not video_id:
            continue
        video_url = entry.get("url")
        if not isinstance(video_url, str) or not video_url:
            video_url = f"https://www.youtube.com/watch?v={video_id}"

        title = sanitize_text(str(entry.get("title") or ""))
        published_at = to_iso_date(entry.get("upload_date"))
        duration_seconds = entry.get("duration")
        view_count = entry.get("view_count")
        transcript_cache = transcript_dir / f"{video_id}.json"

        print(f"[youtube-lane] {index}/{len(processing_plan)} transcribing {video_id} :: {title}", file=sys.stderr)
        transcript_status = "failed"
        transcript_language = ""
        transcript_text = ""
        transcript_source = ""
        error_summary = ""
        retry_attempt_count = 0
        retry_backoff_seconds = 0.0
        retry_recovered = False
        transcript_cache_hit = False

        cached_transcript = load_any_complete_transcript(transcript_cache)
        if cached_transcript:
            transcript_status = str(cached_transcript.get("transcript_status") or "complete")
            transcript_language = str(cached_transcript.get("transcript_language") or "")
            transcript_text = sanitize_text(str(cached_transcript.get("transcript_text") or ""))
            transcript_source = str(cached_transcript.get("transcript_source") or "")
            error_summary = ""
            retry_attempt_count = int(cached_transcript.get("acquisition_retry_attempt_count") or 0)
            retry_backoff_seconds = float(cached_transcript.get("acquisition_retry_backoff_seconds") or 0.0)
            retry_recovered = bool(cached_transcript.get("acquisition_retry_recovered"))
            transcript_cache_hit = True

        if transcript_text:
            signal_ids, notes, evidence = extract_signals(transcript_text)
            transcript_words = len(transcript_text.split())
            videos.append(
                {
                    "_sort_index": int(plan_item["original_index"]),
                    "video_id": video_id,
                    "video_url": video_url,
                    "title": title,
                    "published_at": published_at,
                    "duration_seconds": int(duration_seconds) if isinstance(duration_seconds, (int, float)) else None,
                    "duration_text": format_duration(duration_seconds if isinstance(duration_seconds, (int, float)) else None),
                    "view_count": int(view_count) if isinstance(view_count, (int, float)) else None,
                    "transcript_status": transcript_status,
                    "transcript_source": transcript_source,
                    "transcript_language": transcript_language,
                    "transcript_word_count": transcript_words,
                    "retry_attempt_count": retry_attempt_count,
                    "retry_backoff_seconds": retry_backoff_seconds,
                    "retry_recovered": retry_recovered,
                    "transcript_cache_hit": transcript_cache_hit,
                    "implementation_signals": signal_ids,
                    "implementation_notes": notes,
                    "evidence_snippets": evidence,
                    "transcript_excerpt": transcript_text[:320],
                    "error_summary": error_summary,
                }
            )
            if args.sleep_seconds > 0:
                time.sleep(args.sleep_seconds)
            continue

        try:
            (audio_path, info), retry_meta = run_with_retry(
                f"audio download for {video_id}",
                lambda: download_audio(video_url, video_id, audio_dir, args),
                attempts=args.retry_attempts,
                backoff_seconds=args.retry_backoff_seconds,
            )
            retry_attempt_count = int(retry_meta.get("attempt_count") or 0)
            retry_backoff_seconds = float(retry_meta.get("backoff_seconds") or 0.0)
            retry_recovered = bool(retry_meta.get("recovered_after_retry"))
            if not published_at:
                published_at = to_iso_date(info.get("upload_date"))
            if not duration_seconds:
                duration_seconds = info.get("duration")
            if not view_count:
                view_count = info.get("view_count")
            transcript_payload = transcribe_audio(
                model,
                audio_path,
                transcript_cache,
                args.model,
                acquisition_meta=retry_meta,
            )
            transcript_status = str(transcript_payload.get("transcript_status") or "failed")
            transcript_language = str(transcript_payload.get("transcript_language") or "")
            transcript_text = sanitize_text(str(transcript_payload.get("transcript_text") or ""))
            transcript_source = str(transcript_payload.get("transcript_source") or "faster_whisper")
            if not args.keep_audio and audio_path.exists():
                audio_path.unlink(missing_ok=True)
        except Exception as error:  # pragma: no cover - network/model failure path
            error_summary = str(error)

        if not transcript_text:
            try:
                transcript_payload = fetch_auto_captions(video_id, transcript_cache)
                transcript_status = str(transcript_payload.get("transcript_status") or "failed")
                transcript_language = str(transcript_payload.get("transcript_language") or "")
                transcript_text = sanitize_text(str(transcript_payload.get("transcript_text") or ""))
                transcript_source = str(transcript_payload.get("transcript_source") or "youtube_auto_captions")
                error_summary = ""
            except Exception as error:  # pragma: no cover - network/caption failure path
                failures += 1
                error_summary = error_summary or str(error)
                write_json(
                    transcript_cache,
                    {
                        "model_name": args.model,
                        "transcript_source": "",
                        "transcript_status": "failed",
                        "transcript_language": "",
                        "transcript_text": "",
                        "generated_at": iso_now(),
                        "error": error_summary,
                    },
                )
                transcript_status = "failed"
                transcript_language = ""
                transcript_text = ""
                transcript_source = ""

        signal_ids, notes, evidence = extract_signals(transcript_text)
        transcript_words = len(transcript_text.split()) if transcript_text else 0

        videos.append(
            {
                "_sort_index": int(plan_item["original_index"]),
                "video_id": video_id,
                "video_url": video_url,
                "title": title,
                "published_at": published_at,
                "duration_seconds": int(duration_seconds) if isinstance(duration_seconds, (int, float)) else None,
                "duration_text": format_duration(duration_seconds if isinstance(duration_seconds, (int, float)) else None),
                "view_count": int(view_count) if isinstance(view_count, (int, float)) else None,
                "transcript_status": transcript_status,
                "transcript_source": transcript_source,
                "transcript_language": transcript_language,
                "transcript_word_count": transcript_words,
                "retry_attempt_count": retry_attempt_count,
                "retry_backoff_seconds": retry_backoff_seconds,
                "retry_recovered": retry_recovered,
                "transcript_cache_hit": transcript_cache_hit,
                "implementation_signals": signal_ids,
                "implementation_notes": notes,
                "evidence_snippets": evidence,
                "transcript_excerpt": transcript_text[:320],
                "error_summary": error_summary,
            }
        )

        if args.sleep_seconds > 0:
            time.sleep(args.sleep_seconds)

    videos.sort(key=lambda video: int(video.get("_sort_index") or 0))
    for video in videos:
        video.pop("_sort_index", None)
    lane["videos"] = videos
    lane["transcribed_video_count"] = sum(1 for video in videos if video["transcript_status"] == "complete")
    lane["failed_video_count"] = sum(1 for video in videos if video["transcript_status"] != "complete")
    lane["recommendations"] = build_recommendations(videos)

    lane = preserve_last_good_youtube_lane(output_path, lane)
    if int(lane.get("transcribed_video_count") or 0) > 0:
        save_last_good_lane(output_path, lane)
    write_json(output_path, lane)
    print(
        f"[youtube-lane] wrote {output_path} with {lane['transcribed_video_count']} transcript-backed video records",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main())
