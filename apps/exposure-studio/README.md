# SurfaceScope

SurfaceScope is an authorized asset exposure management product scaffold.

It is intentionally **not** a public internet-wide recon engine. The product is designed for:

- assets you own
- assets you operate
- assets you have explicit written authorization to assess

The goal is to help a security team inventory exposed services, track machine-readable findings, and move from exposure evidence to owner-approved remediation and disclosure workflows.

## Product shape

- Rust backend with Axum in `src/`
- static frontend in `frontend/`
- curated demo inventory and source inputs in `data/`
- generated research lane outputs and caches in `data/.generated/`

## Safe-use guardrails

- Keep ownership and authorization state on every asset.
- Preserve evidence and disclosure workflow metadata with every finding.
- Prefer machine-readable imports and scoped findings over raw unauthenticated mass collection.
- Do not add features that optimize for scanning or indexing systems outside an approved asset boundary.

## Local run

```bash
bash apps/exposure-studio/run.sh
```

Then open `http://127.0.0.1:3325`.

## Transcript research lane

Build a transcript-first YouTube research lane with:

```bash
bash apps/exposure-studio/run.sh youtube-lane \
  --channel-url https://www.youtube.com/@TheAIAutomators/videos
```

Build the website text lane with:

```bash
bash apps/exposure-studio/run.sh website-lane
```

The website lane uses an explicit HTTPS allowlist from `data/research_web_targets.json`
as seeds, then performs a bounded same-origin crawl to cover linked pages without
drifting into unrelated sites.

Build the unified implementation lane with:

```bash
bash apps/exposure-studio/run.sh implementation-lane
```

This refreshes the website and YouTube lanes before merging them into the unified
implementation lane. If you only want to merge the latest generated lane files,
run:

```bash
bash apps/exposure-studio/run.sh implementation-lane --skip-refresh
```

`refresh-all-lanes` is a convenience alias for the same full refresh:

```bash
bash apps/exposure-studio/run.sh refresh-all-lanes
```

Run a preflight doctor check with:

```bash
bash apps/exposure-studio/run.sh youtube-lane doctor
bash apps/exposure-studio/run.sh website-lane doctor
bash apps/exposure-studio/run.sh implementation-lane doctor
```

This bootstraps a local Python virtualenv in `backend/.venv`, downloads audio
for each video, transcribes speech with `faster-whisper`, and writes generated
lane outputs under `data/.generated/`.

The `website-lane` path only needs the standard-library crawler. The heavier
YouTube transcription packages are installed for `youtube-lane`,
`refresh-all-lanes`, and `implementation-lane` refreshes.

The lane is intentionally transcript-only for extraction. Video titles remain
visible as operator metadata, but implementation signals are derived from
speech-to-text output rather than title or description fallback.

On cloud or data-center IPs, YouTube may block direct media access. The runner
keeps those videos in the lane with explicit `transcript_status` and
`error_summary` fields instead of silently falling back to metadata. If needed,
pass a cookies file or proxy:

```bash
bash apps/exposure-studio/run.sh youtube-lane --cookies-file /path/to/cookies.txt
```

You can also point the runner at a browser cookie store directly:

```bash
bash apps/exposure-studio/run.sh youtube-lane \
  --cookies-browser chrome \
  --cookies-browser-profile /path/to/ChromeProfile
```

If no explicit cookie source is configured, the runner tries to auto-detect
common Chrome/Chromium/Brave/Firefox cookie stores in your home directory.

You can also configure defaults through environment variables:

```bash
export YOUTUBE_LANE_COOKIES_FILE=/path/to/cookies.txt
export YOUTUBE_LANE_COOKIES_BROWSER=chrome
export YOUTUBE_LANE_COOKIES_PROFILE=/path/to/ChromeProfile
export YOUTUBE_LANE_PROXY=http://127.0.0.1:8080
export YOUTUBE_LANE_MODEL=tiny
export WEBSITE_LANE_MAX_PAGES=3
export WEBSITE_LANE_CRAWL_DEPTH=1
export YOUTUBE_LANE_RETRY_ATTEMPTS=3
export YOUTUBE_LANE_RETRY_BACKOFF_SECONDS=5
bash apps/exposure-studio/run.sh youtube-lane doctor
bash apps/exposure-studio/run.sh website-lane
bash apps/exposure-studio/run.sh youtube-lane
bash apps/exposure-studio/run.sh implementation-lane
```
