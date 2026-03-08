#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"
ENV_FILE="$LIBRECHAT_DIR/.env"

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file

  tmp_file="$(mktemp)"
  awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$tmp_file"
  printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
  mv "$tmp_file" "$file"
}

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
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$LIBRECHAT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
fi

if ! grep -q "ANYGPT_BASE_URL" "$ENV_FILE"; then
  cat "$ROOT/config/anygpt.env.example" >> "$ENV_FILE"
  echo "Appended AnyGPT env defaults into $ENV_FILE"
fi

# --- Keycloak-first auth: enable SSO, disable local email auth/registration ---
upsert_env_var "$ENV_FILE" "ALLOW_EMAIL_LOGIN" "false"
upsert_env_var "$ENV_FILE" "ALLOW_SOCIAL_LOGIN" "true"
upsert_env_var "$ENV_FILE" "ALLOW_SOCIAL_REGISTRATION" "true"
upsert_env_var "$ENV_FILE" "ALLOW_REGISTRATION" "false"
upsert_env_var "$ENV_FILE" "ALLOW_PASSWORD_RESET" "false"
upsert_env_var "$ENV_FILE" "APP_TITLE" "AnyGPT"
upsert_env_var "$ENV_FILE" "CUSTOM_FOOTER" '"Powered by AnyVM"'
upsert_env_var "$ENV_FILE" "HELP_AND_FAQ_URL" "/"
upsert_env_var "$ENV_FILE" "OPENID_BUTTON_LABEL" "Continue with AnyVM SSO"
upsert_env_var "$ENV_FILE" "OPENID_IMAGE_URL" "/assets/AnyVM-logo.png"
echo "Applied AnyGPT branding and Keycloak defaults"

# --- Generate OPENID_SESSION_SECRET if still placeholder ---
if grep -q "OPENID_SESSION_SECRET=replace_with_random_session_secret" "$ENV_FILE"; then
  SESSION_SECRET=$(openssl rand -hex 32)
  sed -i "s/OPENID_SESSION_SECRET=replace_with_random_session_secret/OPENID_SESSION_SECRET=${SESSION_SECRET}/" "$ENV_FILE"
  echo "Generated random OPENID_SESSION_SECRET"
fi

# --- AnyVM logo for Keycloak login button ---
PUBLIC_DIR="$LIBRECHAT_DIR/client/public/assets"
if [[ -f "$ROOT/AnyVM-logo.png" ]]; then
  mkdir -p "$PUBLIC_DIR"
  cp "$ROOT/AnyVM-logo.png" "$PUBLIC_DIR/AnyVM-logo.png"
  echo "Copied AnyVM-logo.png into $PUBLIC_DIR"
fi
