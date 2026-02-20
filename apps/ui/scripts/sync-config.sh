#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"

if [[ ! -d "$LIBRECHAT_DIR" ]]; then
  echo "LibreChat repo not found at $LIBRECHAT_DIR"
  echo "Clone it with: git clone https://github.com/danny-avila/LibreChat.git $LIBRECHAT_DIR"
  exit 1
fi

cp "$ROOT/config/librechat.yaml" "$LIBRECHAT_DIR/librechat.yaml"

if [[ "${USE_DOCKER:-}" == "1" ]]; then
  cp "$ROOT/config/docker-compose.override.yml" "$LIBRECHAT_DIR/docker-compose.override.yml"
  echo "Copied docker-compose.override.yml into $LIBRECHAT_DIR"
fi

if [[ ! -f "$LIBRECHAT_DIR/.env" ]]; then
  cp "$LIBRECHAT_DIR/.env.example" "$LIBRECHAT_DIR/.env"
  echo "Created $LIBRECHAT_DIR/.env from .env.example"
fi

if ! grep -q "ANYGPT_BASE_URL" "$LIBRECHAT_DIR/.env"; then
  cat "$ROOT/config/anygpt.env.example" >> "$LIBRECHAT_DIR/.env"
  echo "Appended AnyGPT env defaults into $LIBRECHAT_DIR/.env"
fi

echo "Copied librechat.yaml into $LIBRECHAT_DIR"
