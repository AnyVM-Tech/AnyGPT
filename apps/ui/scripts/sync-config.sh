#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"

if [[ ! -d "$LIBRECHAT_DIR" ]]; then
  echo "LibreChat repo not found at $LIBRECHAT_DIR"
  echo "Clone it with: git clone https://github.com/danny-avila/LibreChat.git $LIBRECHAT_DIR"
  exit 1
fi

# --- librechat.yaml ---
cp "$ROOT/config/librechat.yaml" "$LIBRECHAT_DIR/librechat.yaml"
echo "Copied librechat.yaml into $LIBRECHAT_DIR"

# --- Docker override (optional) ---
if [[ "${USE_DOCKER:-}" == "1" ]]; then
  cp "$ROOT/config/docker-compose.override.yml" "$LIBRECHAT_DIR/docker-compose.override.yml"
  echo "Copied docker-compose.override.yml into $LIBRECHAT_DIR"
fi

# --- .env bootstrap ---
if [[ ! -f "$LIBRECHAT_DIR/.env" ]]; then
  cp "$LIBRECHAT_DIR/.env.example" "$LIBRECHAT_DIR/.env"
  echo "Created $LIBRECHAT_DIR/.env from .env.example"
fi

if ! grep -q "ANYGPT_BASE_URL" "$LIBRECHAT_DIR/.env"; then
  cat "$ROOT/config/anygpt.env.example" >> "$LIBRECHAT_DIR/.env"
  echo "Appended AnyGPT env defaults into $LIBRECHAT_DIR/.env"
fi

# --- Keycloak-only auth: enable social login, disable local registration ---
if grep -q "^ALLOW_SOCIAL_LOGIN=false" "$LIBRECHAT_DIR/.env"; then
  sed -i 's/^ALLOW_SOCIAL_LOGIN=false/ALLOW_SOCIAL_LOGIN=true/' "$LIBRECHAT_DIR/.env"
  echo "Enabled ALLOW_SOCIAL_LOGIN"
fi
if grep -q "^ALLOW_SOCIAL_REGISTRATION=false" "$LIBRECHAT_DIR/.env"; then
  sed -i 's/^ALLOW_SOCIAL_REGISTRATION=false/ALLOW_SOCIAL_REGISTRATION=true/' "$LIBRECHAT_DIR/.env"
  echo "Enabled ALLOW_SOCIAL_REGISTRATION"
fi
if grep -q "^ALLOW_REGISTRATION=true" "$LIBRECHAT_DIR/.env"; then
  sed -i 's/^ALLOW_REGISTRATION=true/ALLOW_REGISTRATION=false/' "$LIBRECHAT_DIR/.env"
  echo "Disabled local ALLOW_REGISTRATION (Keycloak-only)"
fi

# --- Generate OPENID_SESSION_SECRET if still placeholder ---
if grep -q "OPENID_SESSION_SECRET=replace_with_random_session_secret" "$LIBRECHAT_DIR/.env"; then
  SESSION_SECRET=$(openssl rand -hex 32)
  sed -i "s/OPENID_SESSION_SECRET=replace_with_random_session_secret/OPENID_SESSION_SECRET=${SESSION_SECRET}/" "$LIBRECHAT_DIR/.env"
  echo "Generated random OPENID_SESSION_SECRET"
fi

# --- AnyVM logo for Keycloak login button ---
PUBLIC_DIR="$LIBRECHAT_DIR/client/public/assets"
if [[ -f "$ROOT/AnyVM-logo.png" ]]; then
  mkdir -p "$PUBLIC_DIR"
  cp "$ROOT/AnyVM-logo.png" "$PUBLIC_DIR/AnyVM-logo.png"
  echo "Copied AnyVM-logo.png into $PUBLIC_DIR"
fi
