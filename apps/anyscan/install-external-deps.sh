#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_ENV_FILE="${ANYSCAN_RUNTIME_ENV_FILE:-/etc/anyscan/runtime.env}"
RUNTIME_ENV_DIR="$(dirname "$RUNTIME_ENV_FILE")"
LOCAL_ENV_FILE="$SCRIPT_DIR/.external-runtime.env"
LOCAL_BOOTSTRAP_ARTIFACT_DIR="${ANYSCAN_LOCAL_BOOTSTRAP_ARTIFACT_DIR:-$REPO_ROOT/.cache/anyscan/bootstrap-artifacts}"

VULNSCANNER_REPO_URL="${ANYSCAN_VULNSCANNER_REPO_URL:-https://github.com/Lorikazzzz/VulnScanner-zmap-alternative.git}"
VULNSCANNER_REPO_DIR="${ANYSCAN_VULNSCANNER_REPO_DIR:-$REPO_ROOT/VulnScanner-zmap-alternative-}"
VULNSCANNER_BIN_PATH="$VULNSCANNER_REPO_DIR/scanner"
VULNSCANNER_INSTALLED_BIN="/opt/anyscan/bin/scanner"

EXTENSION_MANIFESTS="$SCRIPT_DIR/local-bootstrap-provisioner.json,$SCRIPT_DIR/vulnscanner-zmap-adapter.json"
ANYGPT_API_ENV_FILE_DEFAULT="$REPO_ROOT/apps/api/.env"

print_banner() {
	printf '═══════════════════════════════════════════════════════════\n'
	printf '        AnyScan External Repository Setup Script         \n'
	printf '═══════════════════════════════════════════════════════════\n'
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
lines = path.read_text().splitlines() if path.exists() else []
for index, line in enumerate(lines):
    if line.startswith(needle):
        lines[index] = f"{needle}{value}"
        break
else:
    lines.append(f"{needle}{value}")
path.write_text("\n".join(lines) + "\n")
PY
}

print_banner

if ! command -v git >/dev/null 2>&1; then
	printf '[!] git was not found in PATH.\n' >&2
	exit 1
fi

if [ -d "$VULNSCANNER_REPO_DIR/.git" ]; then
	printf '[*] Updating external repository in %s...\n' "$VULNSCANNER_REPO_DIR"
	git -C "$VULNSCANNER_REPO_DIR" fetch --tags --prune
	git -C "$VULNSCANNER_REPO_DIR" pull --ff-only
else
	printf '[*] Cloning %s into %s...\n' "$VULNSCANNER_REPO_URL" "$VULNSCANNER_REPO_DIR"
	git clone "$VULNSCANNER_REPO_URL" "$VULNSCANNER_REPO_DIR"
fi

if [ ! -x "$VULNSCANNER_BIN_PATH" ]; then
	if [ -f "$VULNSCANNER_REPO_DIR/Makefile" ] && command -v make >/dev/null 2>&1; then
		printf '[*] Building VulnScanner scanner binary...\n'
		make -C "$VULNSCANNER_REPO_DIR"
	else
		printf '[!] Scanner binary is missing and make is unavailable.\n' >&2
		exit 1
	fi
fi

if [ ! -x "$VULNSCANNER_BIN_PATH" ]; then
	printf '[!] Expected scanner binary was not created at %s\n' "$VULNSCANNER_BIN_PATH" >&2
	exit 1
fi

mkdir -p "$(dirname "$LOCAL_ENV_FILE")" "$LOCAL_BOOTSTRAP_ARTIFACT_DIR"
printf '[*] Writing repo-local AnyScan env snippet to %s...\n' "$LOCAL_ENV_FILE"
cat >"$LOCAL_ENV_FILE" <<EOF
ANYSCAN_EXTENSION_MANIFEST_PATHS=$EXTENSION_MANIFESTS
ANYSCAN_VULNSCANNER_BIN=$VULNSCANNER_BIN_PATH
ANYSCAN_LOCAL_BOOTSTRAP_ARTIFACT_DIR=$LOCAL_BOOTSTRAP_ARTIFACT_DIR
EOF

if [ -f "$ANYGPT_API_ENV_FILE_DEFAULT" ]; then
	upsert_env_value "ANYSCAN_ANYGPT_API_ENV_FILE" "$ANYGPT_API_ENV_FILE_DEFAULT" "$LOCAL_ENV_FILE"
fi

if [ -d /opt/anyscan/bin ] && [ -w /opt/anyscan/bin ]; then
	printf '[*] Installing scanner into %s...\n' "$VULNSCANNER_INSTALLED_BIN"
	install -m 0755 "$VULNSCANNER_BIN_PATH" "$VULNSCANNER_INSTALLED_BIN"
fi

if { [ -f "$RUNTIME_ENV_FILE" ] && [ -w "$RUNTIME_ENV_FILE" ]; } || { [ ! -e "$RUNTIME_ENV_FILE" ] && [ -d "$RUNTIME_ENV_DIR" ] && [ -w "$RUNTIME_ENV_DIR" ]; }; then
	printf '[*] Updating runtime env file %s...\n' "$RUNTIME_ENV_FILE"
	touch "$RUNTIME_ENV_FILE"
	upsert_env_value "ANYSCAN_EXTENSION_MANIFEST_PATHS" "$EXTENSION_MANIFESTS" "$RUNTIME_ENV_FILE"
	if [ -x "$VULNSCANNER_INSTALLED_BIN" ]; then
		upsert_env_value "ANYSCAN_VULNSCANNER_BIN" "$VULNSCANNER_INSTALLED_BIN" "$RUNTIME_ENV_FILE"
	else
		upsert_env_value "ANYSCAN_VULNSCANNER_BIN" "$VULNSCANNER_BIN_PATH" "$RUNTIME_ENV_FILE"
	fi
	upsert_env_value "ANYSCAN_LOCAL_BOOTSTRAP_ARTIFACT_DIR" "$LOCAL_BOOTSTRAP_ARTIFACT_DIR" "$RUNTIME_ENV_FILE"
	upsert_env_value "ANYSCAN_WORKER_SUPPORTS_BOOTSTRAP" "true" "$RUNTIME_ENV_FILE"
	if [ -f "$ANYGPT_API_ENV_FILE_DEFAULT" ]; then
		upsert_env_value "ANYSCAN_ANYGPT_API_ENV_FILE" "$ANYGPT_API_ENV_FILE_DEFAULT" "$RUNTIME_ENV_FILE"
	fi
else
	printf '[*] Skipping runtime env update because %s is not writable.\n' "$RUNTIME_ENV_FILE"
fi

printf '\nSetup complete.\n\n'
printf 'External repository:\n'
printf '  %s\n' "$VULNSCANNER_REPO_DIR"
printf 'Scanner binary:\n'
printf '  %s\n' "$VULNSCANNER_BIN_PATH"
printf 'Repo-local env snippet:\n'
printf '  %s\n' "$LOCAL_ENV_FILE"
printf '\nYou can source the env snippet for local runs:\n'
printf '  set -a && source %s && set +a\n' "$LOCAL_ENV_FILE"
if [ -f "$RUNTIME_ENV_FILE" ]; then
	printf '\nIf AnyScan is installed as a service, restart it after setup:\n'
	printf '  systemctl restart anyscan-api anyscan-worker\n'
fi
