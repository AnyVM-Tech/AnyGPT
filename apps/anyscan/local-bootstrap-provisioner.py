#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def artifact_dir() -> Path:
    configured = os.environ.get("ANYSCAN_LOCAL_BOOTSTRAP_ARTIFACT_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path("/tmp/anyscan-bootstrap")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return fail("bootstrap provisioner received empty invocation payload")

    try:
        invocation = json.loads(raw)
    except json.JSONDecodeError as error:
        return fail(f"bootstrap provisioner received invalid JSON: {error}")

    job = invocation.get("job")
    candidate = invocation.get("candidate")
    enrollment_token = invocation.get("enrollment_token")
    provisioner_name = invocation.get("provisioner_name")
    executor_worker_id = invocation.get("executor_worker_id")

    if not isinstance(job, dict):
        return fail("bootstrap provisioner invocation is missing a job object")
    if not isinstance(candidate, dict):
        return fail("bootstrap provisioner invocation is missing a candidate object")
    if not isinstance(enrollment_token, str) or not enrollment_token.strip():
        return fail("bootstrap provisioner invocation is missing an enrollment token")
    if not isinstance(provisioner_name, str) or not provisioner_name.strip():
        return fail("bootstrap provisioner invocation is missing a provisioner name")
    if not isinstance(executor_worker_id, str) or not executor_worker_id.strip():
        return fail("bootstrap provisioner invocation is missing an executor worker id")

    try:
        job_id = int(job["id"])
        candidate_id = int(candidate["id"])
    except (KeyError, TypeError, ValueError):
        return fail("bootstrap provisioner invocation is missing a numeric job or candidate id")

    discovered_host = str(job.get("discovered_host") or candidate.get("discovered_host") or "").strip()
    discovered_port = job.get("discovered_port")
    worker_pool = str(job.get("worker_pool") or candidate.get("worker_pool") or "").strip()
    tags = [str(tag).strip() for tag in job.get("tags", []) if str(tag).strip()]

    target_dir = artifact_dir()
    target_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).isoformat()
    artifact_payload = {
        "written_at": timestamp,
        "provisioner_name": provisioner_name,
        "executor_worker_id": executor_worker_id,
        "job": job,
        "candidate": candidate,
        "enrollment_token": enrollment_token,
    }
    json_path = target_dir / f"bootstrap-job-{job_id}.json"
    json_path.write_text(json.dumps(artifact_payload, indent=2, sort_keys=True) + "\n")

    env_lines = [
        f"ANYSCAN_BOOTSTRAP_JOB_ID={job_id}",
        f"ANYSCAN_BOOTSTRAP_CANDIDATE_ID={candidate_id}",
        f"ANYSCAN_BOOTSTRAP_PROVISIONER={shell_quote(provisioner_name)}",
        f"ANYSCAN_BOOTSTRAP_EXECUTOR_WORKER_ID={shell_quote(executor_worker_id)}",
        f"ANYSCAN_BOOTSTRAP_DISCOVERED_HOST={shell_quote(discovered_host)}",
        f"ANYSCAN_WORKER_TOKEN={shell_quote(enrollment_token)}",
    ]
    if discovered_port is not None:
        env_lines.append(f"ANYSCAN_BOOTSTRAP_DISCOVERED_PORT={shell_quote(str(discovered_port))}")
    if worker_pool:
        env_lines.append(f"ANYSCAN_BOOTSTRAP_WORKER_POOL={shell_quote(worker_pool)}")
    if tags:
        env_lines.append(f"ANYSCAN_BOOTSTRAP_TAG_CSV={shell_quote(','.join(tags))}")
    env_lines.append("")
    env_path = target_dir / f"bootstrap-job-{job_id}.env"
    env_path.write_text("\n".join(env_lines))

    print(
        json.dumps(
            {
                "status": "ok",
                "job_id": job_id,
                "candidate_id": candidate_id,
                "artifact_json": str(json_path),
                "artifact_env": str(env_path),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
