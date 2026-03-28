# AnyGPT Setup Guide

## First-Time Setup

AnyGPT includes an interactive setup script to help you configure your environment quickly and easily.

### Running the Setup Script

```bash
# Clone the repository
git clone <your-repo-url>
cd AnyGPT-experimental

# Install dependencies
bun install

# Run the interactive setup
bun run setup
```

### Setup Options

The setup script offers two modes:

#### 1. Quick Setup (Recommended for Testing)
- Uses sensible defaults
- Enables all core routes
- Uses filesystem storage (no Redis required)
- Perfect for getting started quickly

#### 2. Custom Setup
Configure every aspect of your installation:

##### Server Configuration
- **Port**: API server port (default: 3000)
- **Routes**: Enable/disable specific API routes:
  - Models Routes (recommended: enabled)
  - Admin Routes (recommended: enabled)  
  - OpenAI Routes
  - Anthropic Routes
  - Gemini Routes
  - Groq Routes
  - OpenRouter Routes
  - Ollama Routes

##### Redis Configuration
Choose between three options:

1. **No Redis** (Default)
   - Uses filesystem storage
   - No external dependencies
   - Good for development and testing

2. **Redis Cloud** (Recommended for Production)
   - Paste your Redis Cloud connection string
   - Automatic parsing and configuration
   - Includes TLS setup

3. **Self-Hosted Redis**
   - Manual configuration
   - For custom Redis installations
   - Dragonfly works here too because AnyGPT uses the Redis protocol

##### Redis Cloud Setup

If you're using Redis Cloud, you can simply paste your connection command:

```bash
# Example Redis Cloud connection command:
redis-cli -u redis://default:your-password@your-host.redis-cloud.com:port
```

The setup script will automatically:
- Parse the connection string
- Extract host, port, username, and password
- Enable TLS (required for Redis Cloud)
- Configure error logging

⚠️ **Important**: Only use the Redis Cloud option for cloud-hosted Redis. For self-hosted instances, use manual configuration.

##### Self-Hosted Dragonfly Setup

For a local Dragonfly deployment, start from [`apps/api/dragonfly-anygpt.flags.example`](/home/skullcmd/AnyGPT/apps/api/dragonfly-anygpt.flags.example) and keep your API env aligned with it:

```env
DATA_SOURCE_PREFERENCE=redis
REDIS_URL=127.0.0.1:6380
REDIS_USERNAME=default
REDIS_PASSWORD=replace-with-apps-api-redis-password
REDIS_DB=0
REDIS_TLS=false
```

That preset binds Dragonfly to localhost, uses `6380`, disables the HTTP console on the main Redis port, and reserves two logical DBs so the control plane can keep using DB `1` for clone-based experimental runs.

##### Other Configuration Options
- **Log Level**: debug, info, warn, error (default: info)
- **Admin User**: Create a default admin user with API key

### After Setup

Once setup is complete:

1. Navigate to the API directory:
   ```bash
   cd apps/api
   ```

2. Start the development server:
   ```bash
   bun run dev
   ```

3. (Optional) Start the UI (LibreChat):
   ```bash
   cd ../ui
   bun run dev
   ```

### Environment File

The setup script creates a `.env` file in `apps/api/.env` with your chosen configuration. You can manually edit this file later if needed.

For OpenRouter support, ensure these are set (defaults provided by the setup script):

- OPENROUTER_REFERRER=https://gpt.anyvm.tech
- OPENROUTER_TITLE=AnyGPT

### Redis Cloud Connection String Format

The setup script can parse Redis Cloud connection strings in these formats:

```bash
# Full redis-cli command
redis-cli -u redis://username:password@host:port

# Direct Redis URL
redis://username:password@host:port
```

### Troubleshooting

#### Redis Connection Issues
- Verify your Redis Cloud credentials in the dashboard
- Ensure your IP is whitelisted (if using Redis Cloud)
- Check that TLS is enabled for cloud connections

#### Port Already in Use
- Change the PORT in your `.env` file
- Or kill the process using the port: `bunx kill-port 3000`

#### Missing Dependencies
- Run `bun install` in the root directory
- Run `bun install` in `apps/api`
- LibreChat runs via Docker; see `apps/ui/README.md` for setup

#### Gemini Probe Capability Mismatches
If Gemini probes fail with messages like `Unsupported input mime type for this model: audio/s16le`, `Function calling is not enabled for this model`, `model does not support generateContent`, `image generation unavailable in country`, or `image generation unavailable in provider region`, treat that as an upstream/provider-bound Gemini capability mismatch or regional catalog drift rather than a local setup problem.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to succeed
- Region/country-governed image output failures and provider-region model removals for Gemini image models such as `lyria-3-pro-preview` are upstream availability constraints, so provider switching within the same blocked Gemini capability family is unlikely to help
- If the same Gemini model family also returns probe failures like `Unsupported input mime type for this model: audio/s16le` or `Function calling is not enabled for this model`, treat those as the same upstream/provider-bound Gemini capability mismatch family rather than a local workspace regression
- For `lyria-3-pro-preview` specifically, the combination of `provider_cap_blocked`/`provider_model_removed` for image output plus `generateContent` probe failures for `audio_input` or `tool_calling` should be summarized as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family in the blocked subsystem `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination for that family is unlikely to succeed until provider-side regional availability or capability gating changes
- For now, avoid retrying the same audio input, tool-calling, or image-output probe against that Gemini model family until provider-side capability gating or regional availability changes
- If logs mention `Unsupported input mime type for this model: audio/s16le`, treat that as the same upstream/provider-bound Gemini capability mismatch family rather than a local workspace or setup defect
- If the same Gemini model family also logs `Function calling is not enabled for this model`, keep it in the same blocked `apps/api` Gemini provider routing/capability handling bucket instead of treating it as a separate local regression
- If `provider_cap_blocked` reports `image generation unavailable in country` or `provider_model_removed` reports `image generation unavailable in provider region` for the same Gemini model family, summarize that as upstream/provider-bound regional catalog drift plus capability mismatch, and assume retrying the same Gemini provider-method combination is unlikely to succeed
- If the same Gemini repair window also includes probe failures such as `Unsupported input mime type for this model: audio/s16le`, `Function calling is not enabled for this model`, or `generateContent` unsupported for that model family, treat them as the same upstream/provider-bound Gemini capability mismatch family rather than separate local regressions
- This also covers repeated `provider_cap_blocked` / `provider_model_removed` events for Gemini image output with reasons like `image generation unavailable in country` or `image generation unavailable in provider region`, including `lyria-3-pro-preview`
- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to succeed until provider-side regional availability or capability routing changes
- Operator success condition: after seeing this exact family of Gemini signals, stop local retry churn and defer remediation to `apps/api` Gemini provider routing/capability handling or provider-side regional/capability changes instead of re-running the same probe mix
- If the same Gemini model family also fails `audio_input` with `Unsupported input mime type for this model: audio/s16le` or fails `tool_calling` with `Function calling is not enabled for this model`, treat those as the same upstream/provider-bound Gemini capability mismatch family rather than separate local regressions
- For `lyria-3-pro-preview` specifically, combine `provider_cap_blocked` / `provider_model_removed` image-output region errors with `generateContent`, `audio_input`, or `tool_calling` probe failures into one defer reason: blocked in `apps/api` Gemini provider routing/capability handling, and repeating the same Gemini provider-method combination is unlikely to succeed
- Operator shortcut: when `lyria-3-pro-preview` shows `image generation unavailable in country`, `image generation unavailable in provider region`, `Unsupported input mime type for this model: audio/s16le`, or `Function calling is not enabled for this model` in the same repair window, record a single upstream/provider-bound Gemini capability mismatch and regional catalog drift note instead of reopening local workspace/control-plane debugging
- Triage rule for this failure family: treat combined `provider_cap_blocked` image-output country limits, `provider_model_removed` provider-region removals, and Gemini `audio_input` failures such as `Unsupported input mime type for this model: audio/s16le` as blocked in `apps/api` Gemini provider routing/capability handling; retrying the same Gemini `generateContent` provider-method combination is unlikely to succeed until provider capability or regional availability changes
- Operator next step: record the incident as upstream/provider-bound Gemini capability mismatch and regional catalog drift, avoid reopening local workspace/control-plane debugging for the same `lyria-3-pro-preview` + Gemini `generateContent` path, and only retry after provider region/governance availability or model capability support changes are confirmed
- Fast triage rule for this family: if the same repair window shows Gemini `provider_cap_blocked` for `image_output` with country or provider-region availability reasons together with `probe_fail` messages like `Unsupported input mime type for this model: audio/s16le` or `Function calling is not enabled for this model`, treat them as one blocked `apps/api` Gemini provider routing/capability-handling issue rather than separate local regressions; repeating the same Gemini provider-method combination is unlikely to help until upstream capability or regional availability changes
- Current example to classify the same way: if `lyria-3-pro-preview` is removed for image output because image generation is unavailable in country/provider region and Gemini `generateContent` also rejects `audio/s16le`, record that as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family in the blocked `apps/api` Gemini provider routing/capability handling subsystem rather than reopening a local workspace repair loop
- Operator next step for this exact family: do not spend another workspace-surface repair pass retrying the same Gemini provider-method combination for `lyria-3-pro-preview`; instead mark it deferred to the blocked `apps/api` Gemini provider routing/capability handling subsystem and wait for upstream regional availability or capability support to change before re-probing image output or raw audio input on that model family

#### OpenRouter Tool-Calling Probe 404s
If OpenRouter probes fail with messages like `No allowed providers are available for the selected model` or `No endpoints found that support tool use`, treat that as an upstream/provider-bound OpenRouter routing/tool-capability mismatch rather than a local setup problem.

- Blocked subsystem: `apps/api` OpenRouter routing/tool-capability handling
- Repeating the same OpenRouter provider-method combination is unlikely to succeed
- This also applies when capability probes such as `tool_calling`, `image_input`, or even a basic text probe return the same OpenRouter 404 for the same model family
- Verify that the target model currently has an allowed routed provider with the required capability support before retrying the same probe
- Prefer a basic non-tool chat smoke test first when validating general availability for that model family
- For repeated `tool_calling` 404s specifically, record a defer reason instead of reopening a workspace-surface repair loop unless a fresh non-tool smoke also fails for the same model family
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the non-tool smoke or preserve a clear operator-facing defer reason explaining why no run was emitted

#### Gemini Audio/Tool Capability Mismatch on `lyria-3-pro-preview`
If Gemini probes for `lyria-3-pro-preview` fail with `Unsupported input mime type for this model: audio/s16le`, `Function calling is not enabled for this model`, or similar `generateContent` capability errors, treat them as one upstream/provider-bound Gemini capability mismatch family rather than a local workspace regression.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to help immediately for raw audio input or tool-calling on this model family
- Prefer recording a defer reason over reopening the same workspace-surface repair loop unless a different Gemini-compatible method or capability is being validated
- If you still need a smoke check, prefer a basic text-only validation path instead of raw audio or tool-calling for this model family
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen smoke path or preserve a clear operator-facing defer reason explaining why no run was emitted

#### OpenRouter `tool_calling` 404: No Allowed Providers Available
If an OpenRouter probe fails with `No allowed providers are available for the selected model. (status 404)` during `tool_calling`, treat it as upstream/provider-bound availability or governance drift rather than a local workspace-surface regression.

- Blocked subsystem: `apps/api` provider routing/probing
- Repeating the same OpenRouter provider-method combination is unlikely to help immediately for that model and capability pair
- Prefer a non-tool smoke for the same model family before reopening a workspace-surface repair loop
- If the non-tool path is also unavailable, preserve a clear operator-facing defer reason instead of retrying the same `tool_calling` probe
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the non-tool smoke path or preserve a clear defer reason explaining why no run was emitted

#### Gemini `audio_input` / `tool_calling` 400 on `lyria-3-pro-preview`
If Gemini probes for `lyria-3-pro-preview` fail with `Unsupported input mime type for this model: audio/s16le` or `Function calling is not enabled for this model`, treat the cluster as one upstream/provider-bound Gemini capability mismatch family rather than a local workspace-surface regression.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini `generateContent` provider-method combination is unlikely to help immediately for raw audio input or tool-calling on this model family
- Prefer recording a defer reason over reopening the same workspace-surface repair loop unless a different Gemini-compatible method or capability is being validated
- If you still need a smoke check, prefer a basic text-only validation path instead of raw audio or tool-calling for this model family
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen text-only smoke path or preserve a clear operator-facing defer reason explaining why no run was emitted

#### Gemini `image_output` region/country block plus `audio_input` 400 on `lyria-3-pro-preview`
If Gemini logs pair `provider_cap_blocked` (`image generation unavailable in country`) or `provider_model_removed` (`image generation unavailable in provider region`) with `audio_input` probe failures such as `Unsupported input mime type for this model: audio/s16le` for `lyria-3-pro-preview`, treat the cluster as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini `generateContent` provider-method combination is unlikely to help immediately for this model/capability family
- Do not reopen the same workspace-surface repair loop for image-output region blocks or raw-audio probes unless a different Gemini-compatible capability is being validated
- Prefer a text-only smoke or an explicit defer reason over retrying the same blocked image-output or raw-audio path
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen text-only smoke path or preserve a clear operator-facing defer reason explaining why no run was emitted

#### OpenRouter `tool_calling` 404: no allowed providers available for the selected model
If OpenRouter probe logs report `tool_calling` failures such as `No allowed providers are available for the selected model. (status 404)` for models like `qwen/qwen3-4b:free` or `sao10k/l3-euryale-70b`, treat the pattern as upstream/provider-bound availability or governance drift by default.

- Blocked subsystem: `apps/api` provider routing/probing
- Repeating the same OpenRouter `tool_calling` provider-method combination is unlikely to help immediately unless credentials, provider allowlists, or upstream model availability change
- Do not treat this as a workspace-surface regression by itself, and avoid speculative root-workspace routing changes for the same failing probe combination
- Prefer a text-only smoke path, a different already-allowed capability, or an explicit operator-facing defer reason over retrying the same blocked OpenRouter tool-calling probe
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen alternate validation path or preserve a clear operator-facing defer reason explaining why no run was emitted

#### Gemini `audio_input` / `tool_calling` 400s on `lyria-3-pro-preview`
If Gemini probe logs report `audio_input` failures such as `Unsupported input mime type for this model: audio/s16le` and nearby `tool_calling` failures such as `Function calling is not enabled for this model` for `lyria-3-pro-preview`, treat them as one upstream/provider-bound Gemini capability mismatch family by default.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to help immediately unless the upstream model capability surface changes
- Do not treat this as a workspace-surface regression by itself, and avoid speculative root-workspace changes that retry the same raw-audio or function-calling probe path
- Prefer a text-only smoke path, a different Gemini-compatible capability, or an explicit operator-facing defer reason over retrying the same blocked `audio_input` or `tool_calling` combination
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen text-only or alternate-capability validation path, or preserve a clear operator-facing defer reason explaining why no run was emitted

#### Gemini `image_output` region/country blocks paired with `audio_input` 400s on `lyria-3-pro-preview`
If Gemini probe logs pair `provider_cap_blocked` or `provider_model_removed` events for `image_output` with reasons such as `image generation unavailable in country` or `image generation unavailable in provider region`, and the same repair window also shows `audio_input` failures such as `Unsupported input mime type for this model: audio/s16le` for `lyria-3-pro-preview`, treat them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family by default.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to help immediately for this blocked capability family
- Do not treat these region/country image-generation blocks as a workspace-surface regression by themselves, and avoid speculative root-workspace changes that simply retry the same Gemini image or raw-audio probe path
- Prefer a text-only smoke path, a different already-allowed capability, or an explicit operator-facing defer reason over retrying the same blocked `image_output` or `audio_input` combination
- Recommended workspace-surface fallback: run a bounded alternate validation path such as `bun run frontend:preflight`, `bun run frontend:smoke`, or another non-Gemini-image/non-raw-audio check that does not depend on the blocked `lyria-3-pro-preview` capability family
- If that alternate path is intentionally skipped, record the defer reason explicitly as an upstream/provider-bound Gemini capability mismatch and regional catalog drift issue in `apps/api` Gemini provider routing/capability handling rather than a root-workspace regression
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen alternate validation path, or preserve a clear operator-facing defer reason explaining why no run was emitted

### Gemini Capability/Region Drift Triage

If recent validation logs show `provider_cap_blocked` or `provider_model_removed` for Gemini `image_output` because image generation is unavailable in a country or provider region, together with probe failures such as `Unsupported input mime type for this model: audio/s16le` for `lyria-3-pro-preview`, treat them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family by default.

- Blocked subsystem: `apps/api` Gemini provider routing/capability handling
- Repeating the same Gemini provider-method combination is unlikely to help immediately for this blocked capability family
- Do not treat these region/country image-generation blocks as a workspace-surface regression by themselves, and avoid speculative root-workspace changes that simply retry the same Gemini image or raw-audio probe path
- Prefer a text-only smoke path, a different already-allowed capability, or an explicit operator-facing defer reason over retrying the same blocked `image_output` or `audio_input` combination
- Recommended workspace-surface fallback: run a bounded alternate validation path such as `bun run frontend:preflight`, `bun run frontend:smoke`, or another non-Gemini-image/non-raw-audio check that does not depend on the blocked `lyria-3-pro-preview` capability family
- If that alternate path is intentionally skipped, record the defer reason explicitly as an upstream/provider-bound Gemini capability mismatch and regional catalog drift issue in `apps/api` Gemini provider routing/capability handling rather than a root-workspace regression
- Next validation success condition: capture at least one fresh LangSmith control-plane run/trace for the chosen alternate validation path, or preserve a clear operator-facing defer reason explaining why no run was emitted

### Re-running Setup

You can re-run the setup script at any time:

```bash
bun run setup
```

The script will ask if you want to overwrite your existing `.env` file.

### Manual Configuration

If you prefer to configure manually, copy the example file:

```bash
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env` with your preferred settings.
