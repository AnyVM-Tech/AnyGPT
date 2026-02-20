# LibreChat UI (AnyGPT)

This folder replaces the previous UI with LibreChat. The LibreChat repo is expected at `apps/ui/librechat`, and this wrapper supplies AnyGPT-specific config.
`apps/ui/librechat` is git-ignored so you can clone LibreChat locally without vendoring it into this repo.

## Quick Start

1. Clone LibreChat into this folder:
   ```bash
   git clone https://github.com/danny-avila/LibreChat.git apps/ui/librechat
   ```

2. Ensure MongoDB is running and update `apps/ui/librechat/.env` if needed:
   - Default expects `MONGO_URI=mongodb://127.0.0.1:27017/LibreChat`
   - Use a remote MongoDB URI if you prefer

3. Adjust AnyGPT endpoint env vars (the wrapper will append defaults if missing):
   - `ANYGPT_BASE_URL=http://localhost:3000/v1`
   - `ANYGPT_API_KEY=...`

4. Start LibreChat:
   ```bash
   pnpm --filter anygpt-ui dev
   ```
   If dependencies are missing, run:
   ```bash
   (cd apps/ui/librechat && npm install)
   ```

## What This Wrapper Does

- `config/librechat.yaml` defines a custom endpoint named `AnyGPT` that points to your AnyGPT OpenAI-compatible `/v1` API.
- `scripts/sync-config.sh` copies `librechat.yaml` into `apps/ui/librechat` and ensures `.env` exists with AnyGPT defaults.
- If you set `USE_DOCKER=1`, `config/docker-compose.override.yml` is also copied for Docker runs.

## Notes

- If you want per-user API keys, change `apiKey` in `config/librechat.yaml` to `user_provided`.
- Update the `models.default` list in `config/librechat.yaml` to match your AnyGPT `GET /v1/models` output.
