# Bun Runtime Migration Handoff

## Current Goal

Continue the Bun-native migration and Gemini latency work in a new chat.

## Important Context

- The workspace package manager is now Bun.
- The checked-in API runtime path has been moved to Bun.
- The deployed `anygpt` systemd service has been switched to the Bun-backed runtime path and now uses the Bun launcher flow.
- The conversation context was getting high, so this file is the handoff summary.
- For the API latency investigation, **treat all providers as shared**. Do not assume isolated per-request provider pools.

## Key Runtime Files

- `bun.sh`
- `bun.lock`
- `bunfig.toml`
- `apps/api/package.json`
- `apps/api/server.bun.ts`
- `apps/api/server.launcher.bun.ts`
- `apps/api/lib/uws-compat.ts`
- `apps/api/anygpt-api.service`
- `apps/api/anygpt-experimental.service`

## What Was Changed

### Package/runtime migration

- Root and workspace manifests were moved from pnpm to Bun scripts/metadata.
- `pnpm-lock.yaml` was removed and replaced by `bun.lock`.
- Repo helper script `bun.sh` was added so service and script entrypoints resolve Bun consistently.

### API runtime

- `apps/api/lib/uws-compat.ts` was rewritten into a Bun-native adapter layer.
- `apps/api/server.bun.ts` was added as the Bun-native API entrypoint.
- `apps/api/server.launcher.bun.ts` was added as a Bun-native multi-process launcher.
- `apps/api/package.json` start scripts were redirected to the Bun-native entrypoints.

### Service templates

- `apps/api/anygpt-api.service` now points at Bun-native build/start.
- `apps/api/anygpt-experimental.service` now points at Bun-native build/start.

## What Was Validated

- `/v1/models` works on the Bun-native runtime.
- Authenticated non-streaming `/v1/chat/completions` returns a proper JSON body.
- Authenticated non-streaming `/v1/responses` returns a proper JSON body.
- Streaming `/v1/chat/completions` now emits role chunk, non-empty content chunk, final completion chunk, and `[DONE]`.
- Streaming `/v1/responses` emits the expected event sequence.
- The Bun-native launcher path was tested with multiple workers.

## Important Deployed State

- The deployed `anygpt` service is using Bun.
- The deployed `anygpt` service was switched to `CLUSTER_WORKERS=auto` so it uses the Bun-native multi-process launcher.
- Earlier hangs were caused by the old cluster-style request worker path being incompatible with the Bun runtime; that path was removed from the deployed service.

## Current Investigation: Gemini Slowness

The main unresolved product problem is Gemini latency under quota/cooldown pressure.

### Current conclusion

The slowdown is primarily in provider selection/cooldown waiting logic inside `apps/api/providers/handler.ts`, not in the Bun transport itself.

Relevant areas:

- cooldown wait / reuse logic around the non-streaming provider path
- cooldown wait / reuse logic around the streaming provider path
- rate-limit window calculations
- request queue / provider retry behavior

### Critical assumption for future work

**All providers are shared.**

That means the right design direction is a shared availability queue / reservation model, not repeated per-request rescans through a globally exhausted provider pool.

## Recommended Next Task In A New Chat

1. Inspect `apps/api/providers/handler.ts`
2. Treat provider availability as a shared resource across requests
3. Replace repeated cooldown rescans with a reservation / wait-queue model
4. Preserve “wait until provider finishes” semantics without immediate failure when all providers are cooling down
5. Keep request deadline behavior as the hard stop

## Suggested Prompt For The Next Chat

"Continue from `plans/bun-runtime-handoff.md`. The Bun-native runtime migration is already in place. Focus on `apps/api/providers/handler.ts`. For Gemini latency, treat all providers as shared and design/implement a shared availability queue or reservation model so requests wait for an available provider instead of repeatedly rescanning the exhausted pool." 
