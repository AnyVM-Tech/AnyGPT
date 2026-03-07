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
   cd apps/ui
   bun run dev
   ```
   If dependencies are missing, run:
   ```bash
   (cd apps/ui/librechat && bun install)
   ```

## What This Wrapper Does

- `config/librechat.yaml` defines a custom endpoint named `AnyGPT` that points to your AnyGPT OpenAI-compatible `/v1` API.
- `scripts/sync-config.sh` copies `librechat.yaml` into `apps/ui/librechat` and ensures `.env` exists with AnyGPT defaults.
- If you set `USE_DOCKER=1`, `config/docker-compose.override.yml` is also copied for Docker runs.

## AnyVM Branding & Keycloak (OpenID)

- **Keycloak** is connected via LibreChat's OpenID env vars. The wrapper's [`config/anygpt.env.example`](apps/ui/config/anygpt.env.example) ships with production defaults for `auth.anyvm.tech` / `gpt.anyvm.tech`.
- [`scripts/sync-config.sh`](apps/ui/scripts/sync-config.sh) appends the defaults into [`apps/ui/librechat/.env`](apps/ui/librechat/.env) if they are missing, auto-generates `OPENID_SESSION_SECRET`, and copies the AnyVM logo into LibreChat's static assets.
- Key OpenID env vars: `OPENID_CLIENT_ID`, `OPENID_CLIENT_SECRET`, `OPENID_ISSUER`, `OPENID_CALLBACK_URL` (path only — LibreChat prepends `DOMAIN_SERVER`), `OPENID_SESSION_SECRET`, `OPENID_POST_LOGOUT_REDIRECT_URI`, `DOMAIN_CLIENT`, `DOMAIN_SERVER`.
- The actual callback URL constructed by LibreChat is `DOMAIN_SERVER + OPENID_CALLBACK_URL`, i.e. `https://gpt.anyvm.tech/oauth/openid/callback`. This same URL must be listed as a valid redirect URI in the Keycloak client configuration.
- Dark theme defaults are derived from the AnyVM logo palette (`#47b9e7`, `#2472b7`, `#2a8cc8`, `#3688c3`, `#62bfe7`, `#2d9de0`) via the `REACT_APP_THEME_*` variables; override any of those or `APP_TITLE`/`CUSTOM_FOOTER` in [`apps/ui/librechat/.env`](apps/ui/librechat/.env) to customize.
- AnyVM logo references: [`apps/ui/AnyVM-logo.svg`](apps/ui/AnyVM-logo.svg), [`apps/ui/AnyVM-logo.png`](apps/ui/AnyVM-logo.png).

### Keycloak Admin Checklist

In the Keycloak admin console for realm `anyvm`, client `AnyGPT`, verify:

| Setting | Value |
|---------|-------|
| Valid Redirect URIs | `https://gpt.anyvm.tech/oauth/openid/callback` **and** `https://gpt.anyvm.tech/api/admin/oauth/openid/callback` |
| Valid Post Logout Redirect URIs | `https://gpt.anyvm.tech` |
| Web Origins | `https://gpt.anyvm.tech` |
| Client Authentication | ON (confidential) |
| Proof Key for Code Exchange (PKCE) | S256 |

## Nginx Proxy Manager — Shared Domain (`gpt.anyvm.tech`)

Both the LibreChat UI and the AnyGPT API can share `gpt.anyvm.tech` because their route prefixes don't overlap:

| Routes | Backend | Port |
|--------|---------|------|
| `/v1/*`, `/v2/*`, `/v3/*`, `/v4/*`, `/v5/*`, `/v6/*` | AnyGPT API | 3000 |
| `/admin/*`, `/openapi.json` | AnyGPT API | 3000 |
| Everything else (`/`, `/api/*`, `/oauth/*`, etc.) | LibreChat | 3080 |

### Setup in Nginx Proxy Manager

1. **Edit (or create) the proxy host** for `gpt.anyvm.tech`:
   - **Default destination**: `http://<host-ip>:3080` (LibreChat)
   - Enable **SSL**, **Force SSL**, and **HTTP/2**

2. **Add Custom Locations** (in the proxy host's "Custom Locations" tab):

   | Location | Forward Hostname/IP | Forward Port | Scheme |
   |----------|-------------------|--------------|--------|
   | `/v1` | `<host-ip>` | `3000` | `http` |
   | `/v2` | `<host-ip>` | `3000` | `http` |
   | `/v3` | `<host-ip>` | `3000` | `http` |
   | `/v4` | `<host-ip>` | `3000` | `http` |
   | `/v5` | `<host-ip>` | `3000` | `http` |
   | `/v6` | `<host-ip>` | `3000` | `http` |
   | `/admin` | `<host-ip>` | `3000` | `http` |
   | `/openapi.json` | `<host-ip>` | `3000` | `http` |

   > Replace `<host-ip>` with the internal IP where AnyGPT API runs (e.g., `127.0.0.1`, `10.x.x.x`, or the Incus container IP).

3. **Alternative: Advanced Nginx config** — If NPM's Custom Locations aren't granular enough, paste this into the proxy host's **Advanced** tab → "Custom Nginx Configuration":

   ```nginx
   # AnyGPT API routes → port 3000
   location ~ ^/(v[1-6]|admin|openapi\.json) {
       proxy_pass http://<host-ip>:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
   }
   ```

LibreChat talks to the AnyGPT API internally via `ANYGPT_BASE_URL=http://localhost:3000/v1`, so no proxy is involved in that path.

## Notes

- If you want per-user API keys, change `apiKey` in `config/librechat.yaml` to `user_provided`.
- Update the `models.default` list in `config/librechat.yaml` to match your AnyGPT `GET /v1/models` output.
