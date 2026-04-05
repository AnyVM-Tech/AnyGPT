#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3325}"
export PORT

SECRETS_FILE="$ROOT_DIR/.lane-secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
fi

cd "$ROOT_DIR"

if [[ "${1:-}" == "youtube-lane" || "${1:-}" == "website-lane" || "${1:-}" == "implementation-lane" || "${1:-}" == "refresh-all-lanes" ]]; then
  LANE_NAME="$1"
  shift
  PYTHON_BIN="${PYTHON_BIN:-python3}"
  VENV_DIR="$ROOT_DIR/backend/.venv"
  REQUIREMENTS_FILE="$ROOT_DIR/backend/requirements-youtube-research.txt"
  INSTALL_YOUTUBE_STACK=0
  case "$LANE_NAME" in
    youtube-lane)
      RUNNER_FILE="$ROOT_DIR/backend/youtube_research_runner.py"
      INSTALL_YOUTUBE_STACK=1
      ;;
    website-lane)
      RUNNER_FILE="$ROOT_DIR/backend/website_research_runner.py"
      ;;
    implementation-lane)
      RUNNER_FILE="$ROOT_DIR/backend/implementation_lane_runner.py"
      INSTALL_YOUTUBE_STACK=1
      SKIP_REFRESH=0
      IS_DOCTOR=0
      for arg in "$@"; do
        if [[ "$arg" == "--skip-refresh" ]]; then
          SKIP_REFRESH=1
        elif [[ "$arg" == "doctor" ]]; then
          IS_DOCTOR=1
        fi
      done
      if [[ "$SKIP_REFRESH" == "1" && "$IS_DOCTOR" == "0" ]]; then
        INSTALL_YOUTUBE_STACK=0
      fi
      ;;
    refresh-all-lanes)
      RUNNER_FILE="$ROOT_DIR/backend/implementation_lane_runner.py"
      set -- run
      INSTALL_YOUTUBE_STACK=1
      ;;
  esac

  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
  if [[ "$INSTALL_YOUTUBE_STACK" == "1" ]]; then
    "$VENV_DIR/bin/python" -m pip install --quiet -r "$REQUIREMENTS_FILE"
  fi
  exec "$VENV_DIR/bin/python" "$RUNNER_FILE" "$@"
fi

exec cargo run --release
