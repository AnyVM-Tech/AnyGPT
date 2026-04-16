#!/usr/bin/env python3
from __future__ import annotations

import ipaddress
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_RATE_LIMIT = 1_000
DEFAULT_SENDER_THREADS = 1
DEFAULT_RECEIVER_THREADS = 1
DEFAULT_COOLDOWN_SECONDS = 5


def fail(message: str, exit_code: int = 1) -> "None":
    print(message, file=sys.stderr)
    raise SystemExit(exit_code)


def require_string(payload: dict[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        fail(f"missing required invocation field: {key}")
    return value.strip()


def env_string(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def env_int(name: str, default: int) -> int:
    value = env_string(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        fail(f"invalid integer for {name}: {value}")


def env_flag(name: str, default: bool = False) -> bool:
    value = env_string(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def resolve_scanner_binary() -> Path:
    candidates: list[Path] = []
    configured = env_string("ANYSCAN_VULNSCANNER_BIN")
    if configured is not None:
        candidates.append(Path(configured).expanduser())

    script_dir = Path(__file__).resolve().parent
    which_scanner = shutil.which("scanner")
    candidates.extend(
        [
            script_dir.parent / "bin" / "scanner",
            script_dir.parent.parent / "VulnScanner-zmap-alternative-" / "scanner",
            Path("/usr/bin/scanner"),
        ]
    )
    if which_scanner is not None:
        candidates.append(Path(which_scanner))

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    searched = ", ".join(str(candidate) for candidate in candidates)
    fail(
        "unable to locate the VulnScanner binary; set ANYSCAN_VULNSCANNER_BIN or build the repository scanner binary "
        f"(searched: {searched})"
    )


def build_command(invocation: dict[str, object], output_path: Path) -> list[str]:
    scanner_binary = resolve_scanner_binary()
    target_range = require_string(invocation, "target_range")
    ports = require_string(invocation, "ports")
    probe_module = env_string("ANYSCAN_VULNSCANNER_PROBE_MODULE") or "tcp"
    senders = max(1, env_int("ANYSCAN_VULNSCANNER_SENDER_THREADS", DEFAULT_SENDER_THREADS))
    receivers = max(1, env_int("ANYSCAN_VULNSCANNER_RECEIVER_THREADS", DEFAULT_RECEIVER_THREADS))
    cooldown = max(0, env_int("ANYSCAN_VULNSCANNER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS))

    rate_limit = invocation.get("rate_limit")
    if not isinstance(rate_limit, int) or rate_limit <= 0:
        rate_limit = max(1, env_int("ANYSCAN_VULNSCANNER_DEFAULT_RATE", DEFAULT_RATE_LIMIT))

    command = [
        str(scanner_binary),
        "--quiet",
        "--target-range",
        target_range,
        "--port",
        ports,
        "--rate",
        str(rate_limit),
        "--probe-module",
        probe_module,
        "--sender-threads",
        str(senders),
        "--receivers",
        str(receivers),
        "--cooldown-time",
        str(cooldown),
        "--output-file",
        str(output_path),
    ]

    optional_pairs = [
        ("ANYSCAN_VULNSCANNER_INTERFACE", "--interface"),
        ("ANYSCAN_VULNSCANNER_SOURCE_IP", "--source-ip"),
        ("ANYSCAN_VULNSCANNER_GATEWAY_MAC", "--gateway-mac"),
        ("ANYSCAN_VULNSCANNER_BANDWIDTH", "--bandwidth"),
        ("ANYSCAN_VULNSCANNER_PROBE_ARGS", "--probe-args"),
        ("ANYSCAN_VULNSCANNER_WHITELIST_FILE", "--whitelist-file"),
        ("ANYSCAN_VULNSCANNER_BLACKLIST_FILE", "--blacklist-file"),
    ]
    for env_name, flag in optional_pairs:
        value = env_string(env_name)
        if value is not None:
            command.extend([flag, value])

    if env_flag("ANYSCAN_VULNSCANNER_ICMP_PRESCAN"):
        command.append("--icmp")

    extra_args = env_string("ANYSCAN_VULNSCANNER_EXTRA_ARGS")
    if extra_args is not None:
        command.extend(shlex.split(extra_args))

    return command


def parse_target_range(target_range: str) -> tuple[int, int] | None:
    trimmed = target_range.strip()
    if not trimmed:
        return None
    if "/" in trimmed:
        try:
            network = ipaddress.ip_network(trimmed, strict=False)
        except ValueError:
            return None
        if network.version != 4:
            return None
        return int(network.network_address), int(network.broadcast_address)
    if "-" in trimmed:
        start_text, end_text = trimmed.split("-", 1)
        try:
            start = ipaddress.IPv4Address(start_text.strip())
            end = ipaddress.IPv4Address(end_text.strip())
        except ipaddress.AddressValueError:
            return None
        start_value = int(start)
        end_value = int(end)
        if start_value > end_value:
            return None
        return start_value, end_value
    try:
        address = ipaddress.IPv4Address(trimmed)
    except ipaddress.AddressValueError:
        return None
    value = int(address)
    return value, value


def parse_requested_ports(ports: str) -> set[int]:
    requested: set[int] = set()
    for chunk in ports.split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        if '-' in chunk:
            start_text, end_text = chunk.split('-', 1)
            start = int(start_text)
            end = int(end_text)
            if start > end:
                start, end = end, start
            requested.update(range(start, end + 1))
            continue
        requested.add(int(chunk))
    return {port for port in requested if 0 < port < 65536}


def normalized_endpoint(line: str) -> tuple[str, int | None] | None:
    token = line.strip().split()[0] if line.strip() else ""
    if not token:
        return None

    if token.count(":") == 1:
        host, port = token.rsplit(":", 1)
        try:
            address = ipaddress.ip_address(host)
            port_number = int(port)
        except ValueError:
            return None
        if address.version != 4 or not 0 < port_number < 65536:
            return None
        return str(address), port_number

    try:
        address = ipaddress.ip_address(token)
    except ValueError:
        return None
    if address.version != 4:
        return None
    return str(address), None


def emit_endpoints(raw_output: str, target_range: str, requested_ports: str) -> None:
    allowed_range = parse_target_range(target_range)
    allowed_ports = parse_requested_ports(requested_ports)
    single_port = next(iter(allowed_ports)) if len(allowed_ports) == 1 else None
    emitted: set[str] = set()
    for line in raw_output.splitlines():
        endpoint = normalized_endpoint(line)
        if endpoint is None:
            continue
        host, port = endpoint
        host_value = int(ipaddress.IPv4Address(host))
        if allowed_range is not None and not (allowed_range[0] <= host_value <= allowed_range[1]):
            continue
        if port is None:
            if single_port is None:
                continue
            normalized = host
        else:
            if allowed_ports and port not in allowed_ports:
                continue
            normalized = f"{host}:{port}"
        if normalized in emitted:
            continue
        emitted.add(normalized)
        print(normalized)


def main() -> int:
    try:
        invocation = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"invalid scanner adapter invocation json: {error}")

    if not isinstance(invocation, dict):
        fail("scanner adapter invocation must be a json object")

    output_fd, output_name = tempfile.mkstemp(prefix="exposure-vulnscanner-", suffix=".out")
    os.close(output_fd)
    output_path = Path(output_name)

    try:
        command = build_command(invocation, output_path)
        completed = subprocess.run(command, capture_output=True, text=True)
        if completed.returncode != 0:
            stderr = completed.stderr.strip()
            stdout = completed.stdout.strip()
            detail = stderr or stdout or "unknown scanner failure"
            print(detail, file=sys.stderr)
            return completed.returncode

        raw_output = output_path.read_text() if output_path.exists() else completed.stdout
        emit_endpoints(
            raw_output,
            require_string(invocation, "target_range"),
            require_string(invocation, "ports"),
        )

        stderr = completed.stderr.strip()
        if stderr:
            print(stderr, file=sys.stderr)
        return 0
    finally:
        output_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
