#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="/opt/anyscan"
BIN_DIR="$INSTALL_ROOT/bin"
EXTENSIONS_DIR="$INSTALL_ROOT/extensions"
CONFIG_DIR="/etc/anyscan"
STATE_DIR="/var/lib/anyscan"
BOOTSTRAP_ARTIFACT_DIR="$STATE_DIR/bootstrap-artifacts"
ENV_FILE="$CONFIG_DIR/runtime.env"
SERVICE_USER="anyscan"
SERVICE_GROUP="anyscan"
CREATED_ENV=0
ADMIN_PASSWORD=""
REDIS_URL="${REDIS_URL:-}"
REDIS_USERNAME="${REDIS_USERNAME:-}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_DB="${REDIS_DB:-0}"
REDIS_TLS="${REDIS_TLS:-false}"
REDIS_STARTUP_WAIT="${REDIS_STARTUP_WAIT:-1}"
SKIP_REDIS_STARTUP_WAIT="${SKIP_REDIS_STARTUP_WAIT:-0}"
ANYGPT_API_ENV_FILE="${ANYSCAN_ANYGPT_API_ENV_FILE:-${ANYGPT_API_ENV_FILE:-}}"
DEFAULT_REDIS_URL="redis://127.0.0.1:6380/0"
RUNTIME_REDIS_URL="${REDIS_URL:-$DEFAULT_REDIS_URL}"
LOCAL_BOOTSTRAP_MANIFEST="$EXTENSIONS_DIR/local-bootstrap-provisioner.json"
VULNSCANNER_MANIFEST="$EXTENSIONS_DIR/vulnscanner-zmap-adapter.json"
VULNSCANNER_SOURCE_DIR="${VULNSCANNER_SOURCE_DIR:-$SCRIPT_DIR/../../VulnScanner-zmap-alternative-}"
VULNSCANNER_SOURCE_BIN="${VULNSCANNER_SOURCE_BIN:-$VULNSCANNER_SOURCE_DIR/scanner}"
VULNSCANNER_INSTALL_BIN="$BIN_DIR/scanner"
ENABLED_EXTENSION_MANIFESTS="$LOCAL_BOOTSTRAP_MANIFEST"

print_banner() {
    printf '═══════════════════════════════════════════════════════════\n'
    printf '            AnyScan Rust Deploy Script           \n'
    printf '═══════════════════════════════════════════════════════════\n'
}

generate_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32
        printf '\n'
    fi
}

upsert_env_value() {
    local key="$1"
    local value="$2"
    local file="$3"
    python3 - <<'PY' "$file" "$key" "$value"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
needle = f"{key}="
lines = path.read_text().splitlines()
for index, line in enumerate(lines):
    if line.startswith(needle):
        lines[index] = f"{needle}{value}"
        break
else:
    lines.append(f"{needle}{value}")
path.write_text("\n".join(lines) + "\n")
PY
}

remove_env_value() {
    local key="$1"
    local file="$2"
    python3 - <<'PY' "$file" "$key"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
needle = f"{key}="
lines = [line for line in path.read_text().splitlines() if not line.startswith(needle)]
path.write_text("\n".join(lines) + "\n")
PY
}

install_vulnscanner_binary() {
    local source_bin=""
    if [ -x "$VULNSCANNER_SOURCE_BIN" ]; then
        source_bin="$VULNSCANNER_SOURCE_BIN"
        printf '[*] Installing VulnScanner binary from %s...\n' "$source_bin"
    elif [ -f "$VULNSCANNER_SOURCE_DIR/Makefile" ] && command -v make >/dev/null 2>&1; then
        printf '[*] Building VulnScanner binary from %s...\n' "$VULNSCANNER_SOURCE_DIR"
        if ! make -C "$VULNSCANNER_SOURCE_DIR"; then
            printf '[!] Failed to build VulnScanner binary; continuing without scanner adapter enablement.\n' >&2
            return 1
        fi
        source_bin="$VULNSCANNER_SOURCE_DIR/scanner"
        printf '[*] Installing VulnScanner binary from %s...\n' "$source_bin"
    elif command -v scanner >/dev/null 2>&1; then
        source_bin="$(command -v scanner)"
        printf '[*] Installing VulnScanner binary from PATH %s...\n' "$source_bin"
    else
        printf '[!] VulnScanner binary not found; continuing without scanner adapter enablement.\n'
        return 1
    fi

    install -m 0755 "$source_bin" "$VULNSCANNER_INSTALL_BIN"
    return 0
}

print_banner

if [ "$EUID" -ne 0 ]; then
    printf '[!] Please run as root.\n' >&2
    exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
    printf '[!] cargo was not found in PATH. Install the Rust toolchain before deploying.\n' >&2
    exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    printf '[*] Creating service user %s...\n' "$SERVICE_USER"
    useradd --system --user-group --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

printf '[*] Creating runtime directories...\n'
install -d -m 0755 "$INSTALL_ROOT" "$BIN_DIR" "$EXTENSIONS_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR" "$BOOTSTRAP_ARTIFACT_DIR"
install -d -m 0750 "$CONFIG_DIR"

printf '[*] Building release binaries...\n'
cargo build --manifest-path "$SCRIPT_DIR/Cargo.toml" --release --bin anyscan-api --bin anyscan-worker

printf '[*] Installing binaries...\n'
install -m 0755 "$SCRIPT_DIR/target/release/anyscan-api" "$BIN_DIR/anyscan-api"
install -m 0755 "$SCRIPT_DIR/target/release/anyscan-worker" "$BIN_DIR/anyscan-worker"

printf '[*] Installing extension assets...\n'
install -m 0644 "$SCRIPT_DIR/local-bootstrap-provisioner.json" "$LOCAL_BOOTSTRAP_MANIFEST"
install -m 0755 "$SCRIPT_DIR/local-bootstrap-provisioner.py" "$EXTENSIONS_DIR/local-bootstrap-provisioner.py"
install -m 0644 "$SCRIPT_DIR/vulnscanner-zmap-adapter.json" "$VULNSCANNER_MANIFEST"
install -m 0755 "$SCRIPT_DIR/vulnscanner-zmap-adapter.py" "$EXTENSIONS_DIR/vulnscanner-zmap-adapter.py"

if install_vulnscanner_binary; then
    ENABLED_EXTENSION_MANIFESTS="$ENABLED_EXTENSION_MANIFESTS,$VULNSCANNER_MANIFEST"
fi

if [ ! -f "$ENV_FILE" ]; then
    printf '[*] Creating %s...\n' "$ENV_FILE"
    ADMIN_PASSWORD="$(generate_secret | cut -c1-24)"
    JWT_SECRET="$(generate_secret)"
    cat > "$ENV_FILE" <<EOF
ANYSCAN_BIND_ADDR=127.0.0.1:8088
ANYSCAN_ADMIN_USERNAME=admin
ANYSCAN_ADMIN_PASSWORD=$ADMIN_PASSWORD
ANYSCAN_JWT_SECRET=$JWT_SECRET
ANYSCAN_SECURITY_EMAIL=security@anyvm.tech
ANYSCAN_ABUSE_EMAIL=abuse@anyvm.tech
ANYSCAN_OPT_OUT_EMAIL=optout@anyvm.tech
ANYSCAN_ALLOWED_HOST_SUFFIXES=localhost
ANYSCAN_SCAN_CONCURRENCY=16
ANYSCAN_SCAN_INTERVAL_SECONDS=15
ANYSCAN_REDIS_KEY_PREFIX=anyscan:
REDIS_URL=$RUNTIME_REDIS_URL
REDIS_DB=$REDIS_DB
REDIS_TLS=$REDIS_TLS
REDIS_STARTUP_WAIT=$REDIS_STARTUP_WAIT
SKIP_REDIS_STARTUP_WAIT=$SKIP_REDIS_STARTUP_WAIT
# Reuse the AnyGPT API Dragonfly contract for REDIS_* variables.
EOF
    if [ -n "$ANYGPT_API_ENV_FILE" ]; then
        cat >> "$ENV_FILE" <<EOF
ANYSCAN_ANYGPT_API_ENV_FILE=$ANYGPT_API_ENV_FILE
EOF
    else
        cat >> "$ENV_FILE" <<'EOF'
# ANYSCAN_ANYGPT_API_ENV_FILE=/path/to/anygpt/apps/api/.env
EOF
    fi
    if [ -n "$REDIS_USERNAME" ] || [ -n "$REDIS_PASSWORD" ]; then
        cat >> "$ENV_FILE" <<EOF
REDIS_USERNAME=$REDIS_USERNAME
REDIS_PASSWORD=$REDIS_PASSWORD
EOF
    else
        cat >> "$ENV_FILE" <<'EOF'
# REDIS_USERNAME=default
# REDIS_PASSWORD=replace-with-apps-api-redis-password
EOF
    fi
    chmod 0640 "$ENV_FILE"
    chown root:"$SERVICE_GROUP" "$ENV_FILE"
    CREATED_ENV=1
fi

upsert_env_value "ANYSCAN_WORKER_SUPPORTS_BOOTSTRAP" "true" "$ENV_FILE"
upsert_env_value "ANYSCAN_EXTENSION_MANIFEST_PATHS" "$ENABLED_EXTENSION_MANIFESTS" "$ENV_FILE"
upsert_env_value "ANYSCAN_LOCAL_BOOTSTRAP_ARTIFACT_DIR" "$BOOTSTRAP_ARTIFACT_DIR" "$ENV_FILE"
if [ -x "$VULNSCANNER_INSTALL_BIN" ]; then
    upsert_env_value "ANYSCAN_VULNSCANNER_BIN" "$VULNSCANNER_INSTALL_BIN" "$ENV_FILE"
else
    remove_env_value "ANYSCAN_VULNSCANNER_BIN" "$ENV_FILE"
fi

printf '[*] Installing systemd unit files...\n'
install -m 0644 "$SCRIPT_DIR/anyscan-worker.service" /etc/systemd/system/anyscan-worker.service
install -m 0644 "$SCRIPT_DIR/anyscan-api.service" /etc/systemd/system/anyscan-api.service
systemctl daemon-reload

printf '\nDeployment complete.\n\n'
printf 'Next steps:\n'
printf '  1. Review %s and set ANYSCAN_ALLOWED_HOST_SUFFIXES to owned domains.\n' "$ENV_FILE"
printf '  2. Confirm REDIS_URL / REDIS_USERNAME / REDIS_PASSWORD / REDIS_DB / ANYSCAN_REDIS_KEY_PREFIX or ANYSCAN_ANYGPT_API_ENV_FILE point at the isolated Dragonfly namespace.\n'
printf '  3. Review ANYSCAN_EXTENSION_MANIFEST_PATHS and ANYSCAN_VULNSCANNER_BIN in %s.\n' "$ENV_FILE"
printf '  4. Start services: systemctl enable --now anyscan-worker anyscan-api\n'
printf '  5. View logs: journalctl -u anyscan-worker -u anyscan-api -f\n'
printf '  6. Open the dashboard through a local tunnel or reverse proxy to %s\n' "127.0.0.1:8088"

if [ "$CREATED_ENV" -eq 1 ]; then
    printf '\nGenerated bootstrap credentials:\n'
    printf '  username: admin\n'
    printf '  password: %s\n' "$ADMIN_PASSWORD"
    printf '\nStore these values securely and rotate them after first login.\n'
fi
