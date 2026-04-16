# AnyScan Rust Parity + Root Layout Plan

_Date: 2026-04-07_

## Objective

Bring the Rust rebuild of `apps/anyscan` closer to the original Go runtime where that improves defensive scanning value, explicitly reject unsafe/offensive behaviors from the Go implementation, and flatten the Rust code back to the root of `apps/anyscan` so the runtime is organized around a single top-level crate instead of nested `crates/*` packages.

## Implementation status

- [x] Root Rust layout migration completed: the canonical package now lives at `apps/anyscan/Cargo.toml`, with shared modules in `apps/anyscan/src/lib.rs` and binaries in `apps/anyscan/src/bin/exposure-api.rs` and `apps/anyscan/src/bin/exposure-worker.rs`.
- [x] Deployment/service naming cleanup completed for the Rust runtime using `apps/anyscan/deploy.sh` and `apps/anyscan/exposure-worker.service`.
- [x] Safe parity Phase 2 fetch/detector hardening is now implemented in the rooted runtime: profile-driven path catalogs, broader passive detectors, control-probe filtering, duplicate-response suppression, richer evidence capture, and durable telemetry rollups are all present in the root package.
- [x] Phase 3 scheduling and operator visibility are now implemented in the rooted runtime: run summaries carry durable progress breakdowns and activity timing, recurring schedules queue resumable inventory runs through the store-backed worker flow, and the dashboard/API expose failed-target, detector-distribution, and schedule views.
- [x] Phase 4 Go retirement is complete: after validating the legacy reference entry points, the remaining Go root files and module metadata were removed so `apps/anyscan` is now a Rust-only runtime directory again.
- [x] Validation is complete for the final rooted layout: Rust tests, release binary builds, and formatting checks succeed from the canonical root package, and the legacy Go comparison binaries were validated before retirement.

## Current state summary

The current Rust rebuild is not a line-for-line rewrite of the Go runtime; it is a substantially different product shape.

- The original Go runtime used broad host-file-driven scanning, large leak-oriented path coverage, optional proxy usage, and a simple web UI/websocket feed before the retirement pass.
- The original Go orchestrator used continuous external discovery, saved cycle state, proxy replenishment, and scanner subprocess orchestration before the retirement pass.
- The Rust runtime is now rooted directly at `apps/anyscan`, with an authenticated API, queued worker, SQLite-backed store, conservative host allow-listing, profile-driven path expansion, a broader passive detector catalog, and durable recurring schedules. See `apps/anyscan/src/bin/exposure-api.rs:73-107`, `apps/anyscan/src/bin/exposure-worker.rs:36-65`, `apps/anyscan/src/config.rs:12-20`, `apps/anyscan/src/config.rs:112-189`, `apps/anyscan/src/detectors.rs:15-94`, `apps/anyscan/src/store.rs:17-105`, `apps/anyscan/src/store.rs:227-307`, `apps/anyscan/src/store.rs:309-455`.

That difference means parity work must start by deciding what the Rust runtime should intentionally be.

## Inconsistency matrix

### 1. Product boundary and scan model

**Go behavior**
- Reads a broad provider list, scans a user-selected port, and directly probes discovered hosts.
- The orchestrator performs internet-scale external discovery and repeatedly launches the scanner binary.

**Rust behavior**
- Only scans normalized, explicitly configured inventory targets and rejects hosts outside `allowed_host_suffixes`. See `apps/anyscan/src/config.rs:39-55`, `apps/anyscan/src/config.rs:191-269`, `apps/anyscan/src/config.rs:277-366`.
- The worker executes queued runs over stored targets rather than external host discovery. See `apps/anyscan/src/bin/exposure-worker.rs:68-85`, `apps/anyscan/src/bin/exposure-worker.rs:103-178`.

**Disposition**
- Keep the Rust inventory-first boundary.
- Do **not** attempt parity with internet-wide discovery, proxy routing, or zmap-driven scanning.
- Treat the Rust rebuild as a defensive exposure scanner for owned inventory only.

### 2. Discovery/path coverage gap

**Go behavior**
- Probes a very large path set for `.env`, config, framework bundles, Vite `@fs`, proc env leaks, and aiohttp traversal cases.

**Rust behavior**
- Uses a conservative baseline profile plus explicit `js-bundles`, `framework-leaks`, and `legacy-configs` catalogs, then fetches only configured target paths within the owned-inventory boundary. See `apps/anyscan/src/config.rs:88-98`, `apps/anyscan/src/config.rs:112-189`, `apps/anyscan/src/fetcher.rs:21-26`, `apps/anyscan/src/fetcher.rs:52-99`.

**Disposition**
- Port a curated subset of the Go path coverage into Rust as **opt-in scan profiles** for owned assets.
- Preserve normalization and inventory restrictions.
- Avoid blindly copying every traversal path; instead group them by profile (`baseline`, `js-bundles`, `framework-leaks`, `legacy-configs`).

### 3. Detector coverage and verification gap

**Go behavior**
- Detects a wide set of provider secrets and performs special-case processing such as PayPal pairing, Stripe verification, honeypot checks, and provider-specific handling.
- Logs and forwards “valid” findings downstream.

**Rust behavior**
- Now ships a broader passive detector set covering OpenAI, Anthropic, Google, OpenRouter, Stripe, AWS, GitHub, Slack, Discord, and private key material. See `apps/anyscan/src/detectors.rs:15-94`.
- Records findings in SQLite with redaction and events, but does not perform live third-party verification. See `apps/anyscan/src/bin/exposure-worker.rs:181-242`, `apps/anyscan/src/store.rs:338-374`, `apps/anyscan/src/store.rs:453-504`.

**Disposition**
- Expand Rust detector coverage for passive, defensive signatures (OpenAI project keys, Anthropic, Gemini, DeepSeek, OpenRouter, Stripe key formats, PayPal identifier/secret presence, etc.).
- Add safe heuristics like content dedupe, response-diff/honeypot detection, and richer evidence capture.
- Do **not** port payment-API validation, payout behavior, webhook forwarding, or any exfiltration workflow.

### 4. Runtime telemetry and operator UX

**Go behavior**
- Tracks live counters in memory and streams findings/stats via websocket; exposes raw key export and a simple password gate.

**Rust behavior**
- Uses cookie/JWT auth, SQLite-backed dashboard snapshots, and SSE event streaming from the rooted API package. See `apps/anyscan/src/bin/exposure-api.rs:73-107`, `apps/anyscan/src/bin/exposure-api.rs:157-247`, `apps/anyscan/src/bin/exposure-api.rs:249-287`, `apps/anyscan/src/store.rs:376-416`, `apps/anyscan/src/store.rs:493-520`.

**Disposition**
- Keep the Rust API/store/event model.
- Backfill missing operator metrics from the Go UX (more granular progress, request/error counters, run-level timing, filter/export views) without regressing to raw secret export semantics.

### 5. Orchestration gap

**Go behavior**
- Has a dedicated orchestrator with saved state, cycle management, proxy validation, external discovery, and scanner subprocess control.

**Rust behavior**
- Has a single worker daemon that polls queued runs, requeues interrupted jobs for resume, and processes inventory targets concurrently from the rooted package layout. See `apps/anyscan/src/bin/exposure-worker.rs:68-88`, `apps/anyscan/src/bin/exposure-worker.rs:107-183`.
- Now persists recurring schedules in SQLite and queues due schedule runs without duplicating active runs. See `apps/anyscan/src/store.rs:122-136`, `apps/anyscan/src/store.rs:227-307`, `apps/anyscan/src/store.rs:309-455`.

**Disposition**
- Do not recreate the zmap/proxy/orchestrator model.
- Continue using the existing inventory/run queue plus durable recurring schedules and resumable job requeueing instead of external discovery.

### 6. Layout resolution

**Current Rust layout**
- The root `Cargo.toml` is now the canonical `anyscan` package manifest, and the shared library surface lives under `src/lib.rs`. See `apps/anyscan/Cargo.toml:1-31`, `apps/anyscan/src/lib.rs:1-6`.
- The API and worker binaries now live under `src/bin`, with shared modules under `src/`. See `apps/anyscan/src/bin/exposure-api.rs:73-107`, `apps/anyscan/src/bin/exposure-worker.rs:36-65`.
- The dashboard asset is included from the rooted layout. See `apps/anyscan/src/bin/exposure-api.rs:105-106`.

**Disposition**
- The root move is complete; keep future feature work in the rooted package layout.
- Use the remaining plan phases to close safe parity gaps rather than rework packaging again.

## Recommended target architecture

### Keep
- Authenticated API + database-backed dashboard/event model.
- Inventory/allow-list normalization.
- Queued worker execution and redacted finding storage.

### Add
- Richer passive detectors.
- Larger but curated path profiles for owned targets.
- Better run telemetry and operator-facing summaries.
- Optional scheduled/resumable inventory scans on top of the run queue.

### Explicitly do not port
- Internet-wide discovery via zmap.
- Proxy rotation or AWS-target-specific evasion logic.
- Live third-party credential validation against payment providers.
- Any forwarding, exfiltration, or monetary side effects.

## Execution plan

### Phase 0 — Freeze the intended product contract
1. Write down the Rust runtime contract as: “authenticated, owned-inventory exposure scanner.”
2. Mark the Go-only offensive behaviors as non-goals so parity work does not drift.
3. Define safe parity categories:
   - **Port**: passive detectors, path coverage, telemetry, resumable queue execution.
   - **Do not port**: zmap, proxy evasion, credential verification/exfiltration.

### Phase 1 — Move Rust back to the root
1. [x] Convert `apps/anyscan/Cargo.toml` from a pure workspace into the primary package. The canonical root manifest now lives at `apps/anyscan/Cargo.toml:1-31`.
2. [x] Move binary entry points to:
   - `apps/anyscan/src/bin/exposure-api.rs`
   - `apps/anyscan/src/bin/exposure-worker.rs`
3. [x] Collapse shared support crates into root modules under `apps/anyscan/src/`:
   - `config.rs`
   - `core.rs`
   - `detectors.rs`
   - `fetcher.rs`
   - `ops.rs`
   - `store.rs`
4. [x] Update internal imports from path dependencies to module imports via the rooted `anyscan` library surface. See `apps/anyscan/src/lib.rs:1-6`, `apps/anyscan/src/bin/exposure-api.rs:15-23`, `apps/anyscan/src/bin/exposure-worker.rs:5-12`.
5. [x] Fix root-relative asset inclusion for `index.html` after the move. See `apps/anyscan/src/bin/exposure-api.rs:105-106`.
6. [x] Delete `crates/` after tests pass from the new structure and continue future implementation from the rooted package layout.

**Why this order:** it preserved behavior first, changed layout second, and kept parity work separate from the filesystem move.

### Phase 2 — Close safe parity gaps
1. [x] Introduce path-profile catalogs derived from the Go lists, but behind explicit configuration and inventory scoping.
2. [x] Expand detector definitions and tests for the provider/token formats that matter defensively.
3. [x] Add control-probe similarity filtering, duplicate-response suppression, and request/result accounting to the fetch pipeline.
4. [x] Improve evidence capture so findings retain enough context for review without storing raw secrets.

### Phase 3 — Strengthen scheduling and operator visibility
1. [x] Extend the run model with more detailed progress counters and activity timing.
2. [x] Add resumable recurring scans over stored inventory instead of zmap discovery. See `apps/anyscan/src/store.rs:227-307`, `apps/anyscan/src/store.rs:309-455`, `apps/anyscan/src/bin/exposure-worker.rs:68-104`.
3. [x] Expose richer dashboard/API views for run progress, failed targets, detector distribution, and schedules. See `apps/anyscan/src/core.rs:277-395`, `apps/anyscan/src/store.rs:892-1039`, `apps/anyscan/src/bin/exposure-api.rs:91-101`, `apps/anyscan/index.html:431-485`, `apps/anyscan/index.html:807-988`.
4. [x] Replace the remaining backend in-memory-only status notions with durable store-backed events and metrics for queue/run progress. See `apps/anyscan/src/store.rs:854-920`, `apps/anyscan/src/store.rs:1144-1286`, `apps/anyscan/src/bin/exposure-worker.rs:107-183`.

### Phase 4 — Cleanup and Go deprecation boundary
1. [x] Rename leftover deployment/orchestrator naming so the Rust runtime no longer carries Go-era worker labels. See `apps/anyscan/deploy.sh:78-80`, `apps/anyscan/exposure-worker.service:1-13`, `apps/anyscan/exposure-api.service:1-13`.
2. [x] Freeze the Go boundary in reference mode long enough to compare behavior, validate the split legacy entry points, and confirm the Rust runtime can remain the canonical implementation without them.
3. [x] Retire the legacy Go root surface by removing `main.go`, `orchestrator.go`, `go.mod`, and `go.sum` from `apps/anyscan` once the comparison value was exhausted and the final Rust validation pass succeeded.

## Completed root-move map

| Current path | Planned path |
| --- | --- |
| `apps/anyscan/crates/exposure-api/src/main.rs` | `apps/anyscan/src/bin/exposure-api.rs` |
| `apps/anyscan/crates/exposure-worker/src/main.rs` | `apps/anyscan/src/bin/exposure-worker.rs` |
| `apps/anyscan/crates/exposure-config/src/lib.rs` | `apps/anyscan/src/config.rs` |
| `apps/anyscan/crates/exposure-core/src/lib.rs` | `apps/anyscan/src/core.rs` |
| `apps/anyscan/crates/exposure-detectors/src/lib.rs` | `apps/anyscan/src/detectors.rs` |
| `apps/anyscan/crates/exposure-fetcher/src/lib.rs` | `apps/anyscan/src/fetcher.rs` |
| `apps/anyscan/crates/exposure-ops/src/lib.rs` | `apps/anyscan/src/ops.rs` |
| `apps/anyscan/crates/exposure-store/src/lib.rs` | `apps/anyscan/src/store.rs` |

If keeping `src/lib.rs` as the central shared module surface proves too large, the fallback is `src/lib.rs` plus submodules under `src/runtime/*`, but the binaries should still move to `src/bin/*` at the root.

## Acceptance criteria

The plan is complete when the implementation can satisfy all of the following:

1. `apps/anyscan` builds as the real crate root without `crates/*` nesting.
2. API and worker binaries still build and pass tests from the root.
3. Rust retains its authenticated, inventory-scoped operating model.
4. Rust path coverage and detector coverage materially exceed the current rebuild.
5. No Go-only offensive behavior is reintroduced.
6. Deployment naming is consistent with the Rust runtime.

## Suggested implementation order

1. Flatten layout first.
2. Re-run tests/build.
3. Add path profiles and detector expansion.
4. Add richer telemetry/resume features.
5. Clean up naming and retire obsolete Go assumptions.
