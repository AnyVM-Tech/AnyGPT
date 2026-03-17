# AnyGPT API Server

This directory contains the backend API server for AnyGPT, built with HyperExpress on Node.js and TypeScript.

## Overview

The API server acts as a central gateway to various AI model providers. It manages API keys, handles request routing, provides rate limiting, logs errors, and dynamically updates model information. The server supports both Redis and filesystem-based data storage with automatic failover.

## Project Structure

```
apps/api/
├── server.ts           # Main server entry point, initializes and runs the API
├── package.json        # Project dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── .env                # Environment variables (created from .env.example)
├── providers.json      # Stores provider configurations and statistics
├── models.json         # Stores available model details, updated dynamically
├── keys.json           # Stores user API keys and associated data
├── tiers.json          # Defines API usage tiers and their limits
├── providers.schema.json # JSON schema for providers.json
├── models.schema.json  # JSON schema for models.json
├── openapi.json        # OpenAPI spec served at /openapi.json
├── excluded-errors.json # Error patterns excluded from provider auto-disable
|
├── routes/             # Contains route handlers for different API endpoints
│   ├── admin.ts        # Admin-specific routes (e.g., adding providers, generating keys)
│   ├── models.ts       # Routes for listing models and refreshing provider counts
│   ├── openai.ts       # OpenAI compatible API endpoints
│   ├── anthropic.ts    # Anthropic compatible API endpoints
│   ├── gemini.ts       # Gemini compatible API endpoints
│   ├── groq.ts         # Groq compatible API endpoints
│   ├── openrouter.ts   # OpenRouter compatible API endpoints
│   ├── ollama.ts       # Ollama compatible API endpoints
│   ├── openapi.ts      # OpenAPI spec route
│   └── ...             # Other provider-specific routes
|
├── providers/          # Logic for interacting with specific AI provider APIs
│   ├── handler.ts      # Core message handling, provider selection, and stats updates
│   ├── interfaces.ts   # TypeScript interfaces for providers and models
│   ├── openai.ts       # OpenAI provider client
│   ├── gemini.ts       # Gemini provider client
│   └── ...             # Other provider client implementations
|
├── modules/            # Reusable modules for various functionalities
│   ├── dataManager.ts  # Manages dual-source data (Redis/filesystem) with automatic failover
│   ├── modelUpdater.ts # Handles automatic updates to models.json based on provider data
│   ├── errorLogger.ts  # Centralized error logging to file and Redis
│   ├── errorExclusion.ts # Excludes errors from provider auto-disable
│   ├── userData.ts     # Manages user API key generation, validation, and usage tracking
│   ├── compute.ts      # Computes provider statistics, scores, and applies EMA
│   ├── db.ts           # Redis database connection and operations
│   └── typeguards.ts   # TypeScript type guards
|
├── logs/               # Directory for log files (filesystem fallback)
│   └── api-error.jsonl # Detailed error logs in JSON Lines format
|
├── dev/                # Development and testing utilities
│   ├── testApi.ts      # Main API testing script
│   ├── testSetup.ts    # Test environment setup and cleanup
│   ├── mockProvider.ts # Configurable mock AI provider server
│   ├── testMockProvider.ts # Mock provider testing script
│   ├── MOCK_SERVER_CONFIG.md # Mock server configuration documentation
│   ├── models.ts       # Model management utilities
│   ├── updatemodels.ts # Model update scripts
│   ├── updateproviders.ts # Provider update scripts
│   └── ...             # Other development utilities
|
├── server/             # CLI scripts (legacy, being migrated to API routes)
│   ├── addProvider.ts  # Script to add/update providers
│   └── generateApiKey.ts # Script to generate API keys
└── ws/                 # WebSocket and realtime handlers
```

## Features

*   **Multi-Provider Support**: Integrates with OpenAI, Anthropic, Gemini, Groq, OpenRouter, Ollama, DeepSeek, xAI, Imagen, and more via provider configs.
*   **OpenAI-Compatible API**: `/v1` supports chat completions, responses, embeddings, images, videos, audio (speech/transcriptions), and key introspection.
*   **OpenAI-Native Responses Support**: `/v1/responses` is tuned for native OpenAI clients such as Roo Code, with reasoning/tool-call normalization when needed and passthrough fast-paths for simpler text streams.
*   **Provider-Compatible Routers**: Native-style endpoints for Anthropic (`/v3`), Gemini (`/v2`), Groq (`/v4`), Ollama (`/v5`), and OpenRouter (`/v6`).
*   **Dual Data Storage**: Redis primary with filesystem fallback and a short in-memory cache.
*   **Dynamic Model Management**: Updates `models.json` with provider counts and model capabilities (OpenWebUI compatible).
*   **Tier-Based Rate Limiting**: RPS/RPM/RPD limits and provider-score gating per tier (`tiers.json`).
*   **Provider Routing & Health**: Provider scoring, retries/fallback, auto-disable on repeated failures, and error-exclusion patterns.
*   **Admission Queue Isolation**: OpenAI-compatible traffic uses separate queue lanes for `/v1/responses` and provider-family-specific native routing to reduce cross-provider contention.
*   **Image URL Inlining Proxy**: Optional HTTP image fetch with SSRF protections, size/time limits, and per-request referer override.
*   **WebSocket & Realtime**: `/ws` for chat and `/v1/realtime` for realtime-compatible sessions.
*   **OpenAPI Spec**: Served at `/openapi.json` and `/api/openapi.json`.

## Prerequisites

*   Node.js 20.x or 22.x
*   Bun 1.3.10 or newer

## Setup

1.  **Clone the repository.**
2.  **Navigate to the `apps/api` directory:**
    ```bash
    cd apps/api
    ```
3.  **Install dependencies:**
    ```bash
    bun install
    ```
4.  **Create a `.env` file** with your configuration. Key environment variables include:

    ### Core Server Configuration
    *   `PORT`: Port for the API server (default: 3000).
    
    ### Data Storage Configuration
    *   `DATA_SOURCE_PREFERENCE`: Set to `redis` or `filesystem` (default: `redis`).
    *   `REDIS_URL`: Redis Cloud connection URL (format: `host:port`).
    *   `REDIS_USERNAME`: Redis username (default: `default`).
    *   `REDIS_PASSWORD`: Redis password.
    *   `REDIS_DB`: Redis database number (default: 0).
    *   `REDIS_TLS`: Set to `true` for SSL/TLS connections (default: `false`).
    *   `ERROR_LOG_TO_REDIS`: Enable error logging to Redis (default: `true`).

    ### Router Configuration
    *   `ENABLE_OPENAI_ROUTES`: Enable/disable OpenAI routes (default: `true`).
    *   `ENABLE_ANTHROPIC_ROUTES`: Enable/disable Anthropic routes (default: `true`).
    *   `ENABLE_GEMINI_ROUTES`: Enable/disable Gemini routes (default: `true`).
    *   `ENABLE_GROQ_ROUTES`: Enable/disable Groq routes (default: `true`).
    *   `ENABLE_OPENROUTER_ROUTES`: Enable/disable OpenRouter routes (default: `true`).
    *   `ENABLE_OLLAMA_ROUTES`: Enable/disable Ollama routes (default: `true`).
    *   `ENABLE_ADMIN_ROUTES`: Enable/disable admin routes (default: `true`).
    *   `ENABLE_MODELS_ROUTES`: Enable/disable models routes (default: `true`).

    ### Default Admin Configuration
    *   `DEFAULT_ADMIN_USER_ID`: Default admin user ID for auto-creation.
    *   `DEFAULT_ADMIN_API_KEY`: Default admin API key.

    ### Mock Server Configuration (for testing)
    *   `MOCK_BASE_DELAY`: Base response delay in milliseconds (default: 200).
    *   `MOCK_DELAY_VARIANCE`: Random delay variance (default: 100).
    *   `MOCK_ERROR_RATE`: Error simulation rate 0-1 (default: 0.15).
    *   `MOCK_TIMEOUT_RATE`: Timeout simulation rate 0-1 (default: 0.05).
    *   `MOCK_TOKEN_SPEED`: Simulated tokens per second (default: 25).
    *   `MOCK_ENABLE_LOGS`: Enable mock server logging (default: `true`).

    ### Logging & Security
    *   `LOG_LEVEL`: `debug`, `info`, `warn`, `error`, or `silent` (default: `debug` in dev, `info` in production).
    *   `LOG_SENSITIVE_PAYLOADS`: Log full URLs/body snippets for debugging (default: `false`).
    *   `API_KEY_HASH_SECRET`: Secret used to hash API keys in logs (default: `anygpt-api`).
    *   `RATE_LIMIT_HASH_SECRET`: Secret used to hash API keys for Redis rate-limiting keys (default: `anygpt-rate-limit`).
    *   `ADMIN_KEYS_LOG_MAX_ENTRIES`: Maximum number of admin key log entries returned (default: 1000).
    *   `ADMIN_KEYS_LOG_MAX_BYTES`: Rotate admin key log file when it exceeds this size in bytes (default: 5242880).
    *   `ADMIN_KEYS_RATE_LIMIT_RPS`: Rate limit for open admin key ingest endpoint (default: 5).
    *   `ADMIN_KEYS_RATE_LIMIT_RPM`: Rate limit for open admin key ingest endpoint (default: 60).
    *   `ADMIN_KEYS_RATE_LIMIT_RPD`: Rate limit for open admin key ingest endpoint (default: 1000).
    *   `ADMIN_KEYS_MAX_BODY_BYTES`: Max body size for open admin key ingest endpoint (default: 4096).
    *   `ADMIN_KEYS_ALLOWED_PROVIDERS`: Optional comma-separated allowlist for provider IDs (default: unset, allows any provider).
    *   `ADMIN_METRICS_MAX_ERROR_LINES`: Max error log lines scanned for metrics (default: 200000).
    *   `MAX_BODY_LENGTH`: Maximum request body size in bytes (default: 50MB).
    *   `MAX_MAX_TOKENS`: Upper bound for `max_tokens` in OpenAI-compatible requests (default: disabled).
    *   `API_KEY_MIN_LENGTH`: Minimum API key length enforced at auth (default: 32).
    *   `API_KEY_MAX_LENGTH`: Maximum API key length enforced at auth (default: 512).
    *   `MAX_MODEL_ID_LENGTH`: Maximum model id length for incoming payloads (default: 200).
    *   `MAX_ROLE_LENGTH`: Maximum role string length (default: 32).
    *   `MAX_MESSAGE_COUNT`: Max number of messages in a chat payload (default: 200).
    *   `MAX_MESSAGE_PARTS`: Max number of content parts in a message (default: 2000).
    *   `MAX_MESSAGE_CONTENT_CHARS`: Max length of any text content (default: 1,000,000).
    *   `MAX_IMAGE_URL_LENGTH`: Max length of image_url strings (default: 4096).
    *   `MAX_IMAGE_BASE64_CHARS`: Max size of base64 image data (default: 8,000,000).
    *   `MAX_AUDIO_BASE64_CHARS`: Max size of base64 audio data (default: 12,000,000).
    *   `ERROR_LOG_MAX_DETAIL_CHARS`: Cap length of individual log detail strings (default: 4000).
    *   `ERROR_LOG_MAX_DETAIL_KEYS`: Cap number of detail keys per error record (default: 60).

    ### Provider Health & Capabilities
    *   `DISABLE_PROVIDER_AUTO_DISABLE`: Set to `true` to disable auto-disable behavior (default: auto-disable enabled).
    *   `DISABLE_PROVIDER_AFTER_MODELS`: Disable a provider after this many models are disabled (default: 2).
    *   `MODEL_CAPS_REFRESH_MS`: Model capability refresh interval in ms (default: 5000).

     ### Upstream Timeouts & Caches
     *   `UPSTREAM_TIMEOUT_MS`: Upstream HTTP timeout in ms (default: 120000).
     *   `DATA_CACHE_TTL_MS`: In-memory metadata cache TTL in ms (default: `5000`, test default: `0`).
     *   `VIDEO_REQUEST_CACHE_TTL_MS`: TTL for cached video request IDs in ms (default: 3600000).

     ### Admission Queues
     *   `REQUEST_QUEUE_CONCURRENCY`: Concurrency for the shared request-handler queue used by `/v1/chat/completions` and `/v1/responses`.
     *   `REQUEST_QUEUE_MAX_PENDING`: Maximum pending requests allowed in the shared request-handler queue before overload responses are returned.
     *   `REQUEST_QUEUE_MAX_WAIT_MS`: Maximum time a request may wait in the shared request-handler queue before timing out.
     *   `EMBEDDINGS_QUEUE_CONCURRENCY`: Concurrency for the dedicated embeddings admission queue.
     *   `EMBEDDINGS_QUEUE_MAX_PENDING`: Maximum pending requests for the embeddings admission queue.
     *   `PROVIDER_STATS_QUEUE_CONCURRENCY`: Concurrency per provider-stats worker queue.
     *   `PROVIDER_STATS_QUEUE_WORKERS`: Number of provider-stats worker queues.
     *   `PROVIDER_STATS_QUEUE_MAX_PENDING`: Maximum pending jobs per provider-stats worker queue.
     *   `PROVIDER_STATS_FLUSH_MS`: Flush interval for buffered provider-stats updates.
     *   `PROVIDER_STATS_BATCH_SIZE`: Batch size for provider-stats queue processing.
     *   `PROVIDER_STATS_BUFFER_MAX_PENDING`: Maximum buffered provider-stats updates before backpressure/drop behavior applies.

    ### Image URL Fetch Proxy
    *   `IMAGE_FETCH_TIMEOUT_MS`: Image fetch timeout in ms (default: 15000).
    *   `IMAGE_FETCH_MAX_BYTES`: Max image bytes to inline (default: 8MB).
    *   `IMAGE_FETCH_MAX_REDIRECTS`: Max redirects to follow (default: 3).
    *   `IMAGE_FETCH_ALLOW_PRIVATE`: Allow private/loopback hosts (default: `false`).
    *   `IMAGE_FETCH_FORWARD_AUTH`: Forward Authorization header to the original host (default: `false`).
    *   `IMAGE_FETCH_ALLOWED_PROTOCOLS`: Allowlisted protocols (default: `http,https`).
    *   `IMAGE_FETCH_ALLOWED_HOSTS`: Optional allowlist of hosts or suffixes (comma-separated).
    *   `IMAGE_FETCH_USER_AGENT`: User-Agent sent when fetching images.
    *   `IMAGE_FETCH_REFERER`: Default Referer for image fetches (can be overridden per request).

5.  **Initial Data Files**: The server will attempt to create `providers.json`, `models.json`, and `keys.json` if they don't exist. The data will be stored in Redis if configured, with filesystem fallback.

## Running the Server

*   **Development Mode** (with hot-reloading via `tsx`):
    ```bash
    bun run dev
    ```
    This rebuilds the experimental output on change and restarts the Node runtime automatically.

*   **Production Build & Start:**
    ```bash
    # Build the TypeScript code
    bun run build
    
    # Start the compiled server
    bun run start
    ```
    The production build outputs JavaScript files to `dist/production/` and the start script runs `./dist/production/server.js`.

*   **Experimental Build & Start:**
    ```bash
    # Build the experimental bundle
    bun run build:experimental

    # Start the experimental bundle
    bun run start:experimental
    ```
    The experimental build outputs JavaScript files to `dist/experimental/`.

*   **Systemd Services:**
    ```bash
    sudo systemctl status anygpt-api
    sudo systemctl status anygpt-experimental
    ```
    The experimental service uses a separate build output and default port (3000).

## Testing

The project includes a comprehensive testing suite with both unit tests and integration tests using a configurable mock provider.

### Running Tests

*   **Full Test Suite** (recommended):
    ```bash
    bun run test
    ```
    This runs the mock provider, API server, REST/integration checks, and the OpenAI Node SDK compatibility checks concurrently, then cleans up automatically.

*   **Individual Test Components**:
    ```bash
    # Run only the mock provider
    bun run test:mock
    
    # Run only the API server in test mode
    bun run test:dev
    
    # Run only the test scripts (requires servers to be running)
    bun run test:run

    # Run only the OpenAI Node SDK compatibility checks
    bun run test:sdk
    ```

### Mock Provider Testing

The mock provider supports runtime configuration for realistic testing scenarios:

```bash
# Test the mock provider configuration
bun x tsx ./dev/testMockProvider.ts

# Run the mock provider standalone
bun run test:mock
```

See `dev/MOCK_SERVER_CONFIG.md` for detailed documentation on configuring response times, error rates, and other mock behaviors.

## API Endpoints

Authentication is typically via `Authorization: Bearer <YOUR_ANYGPT_API_KEY>` or `api-key`/`x-api-key` headers (provider-compatible routes map provider headers to your AnyGPT key).

### OpenAI-Compatible (`/v1`)
Common endpoints:
*   `POST /v1/chat/completions`
*   `POST /v1/responses`
*   `POST /v1/embeddings`
*   `POST /v1/images/generations`
*   `POST /v1/images/edits`
*   `POST /v1/videos/generations`
*   `GET /v1/videos/{requestId}`
*   `POST /v1/audio/speech`
*   `POST /v1/audio/transcriptions`
*   `GET /v1/audio/voices`
*   `GET /v1/audio/models`
*   `GET /v1/keys/me` (key usage/metrics)
*   `POST /v1/generate_key` (admin)
*   `POST /v1/interactions` and `GET /v1/interactions/{interactionId}`

Notes:
*   [`/v1/responses`](apps/api/routes/openai.ts) is the preferred path for native OpenAI clients such as Roo Code.
*   Plain text Responses streams can use a passthrough fast path for lower latency; reasoning/tool-call cases may be normalized server-side to preserve OpenAI-native semantics.
*   Text-capable Gemini, DeepSeek, xAI/Grok, and similar models can be served through `/v1/responses` when they behave like chat/text models.
*   Media-only or dedicated non-chat models such as embeddings, TTS, STT, image generation, and video generation are redirected to their dedicated endpoints instead of `/v1/responses`.
*   Gemini tool-calling support is normalized in the provider adapter and capability probes, so models like Gemini 3.1 preview variants can now surface `tool_calling` in `models.json` when supported.

### Provider-Compatible Routers
*   Gemini: `/v2`
*   Anthropic: `/v3`
*   Groq: `/v4`
*   Ollama: `/v5`
*   OpenRouter: `/v6`

### Models and Metadata
*   `GET /v1/models` (aliases: `/v1/chat/completions/models`, `/v1/chat/completion/models`)
*   `POST /admin/models/refresh-provider-counts` or `POST /api/admin/models/refresh-provider-counts` (admin)

### Admin
*   Admin endpoints live under `/api/admin` (providers, API keys, metrics) and are also exposed at `/admin`.
*   `GET /api/admin/metrics/summary` returns aggregate provider/model/key counts, queue totals, and error log stats.
*   `GET /api/admin/metrics/queues` returns live queue snapshots for:
    *   the shared request-handler queue used by `/v1/chat/completions` and `/v1/responses`
    *   the dedicated embeddings admission queue
    *   each provider-stats worker queue
*   Queue snapshots include queue label, concurrency, max pending, max wait, in-flight count, pending count, overload count, and last overload timestamp when available.
*   See `openapi.json` for the full list.

### OpenAPI Spec
*   `GET /openapi.json`
*   `GET /api/openapi.json`

## Image URL Fetching

The OpenAI- and OpenRouter-compatible paths can inline HTTP image URLs into base64 before sending upstream. This avoids provider-side URL fetch failures and applies SSRF protections.

*   Use `x-image-fetch-referer` (or `x-image-referer`) to set a per-request Referer for image fetches.
*   Configure allowlists, size limits, and timeouts with the `IMAGE_FETCH_*` environment variables.

## WebSocket Usage

The server exposes a unified WebSocket endpoint at `ws://<host>:<port>/ws` for chat-style completions. An OpenAI Realtime-compatible endpoint is also exposed at `ws://<host>:<port>/v1/realtime`.

### Message Flow

1. Connect to `/ws`.
2. Send auth message:
```json
{ "type": "auth", "apiKey": "YOUR_ANYGPT_API_KEY" }
```
3. On `{ "type": "auth.ok" }`, send a chat request:
```json
{
    "type": "chat.completions",
    "requestId": "req-123",
    "model": "gpt-4o",
    "messages": [ { "role": "user", "content": "Hello from WS" } ]
}
```
4. Receive sequence:
```json
{ "type": "chat.start", "requestId": "req-123" }
{ "type": "chat.complete", "requestId": "req-123", "response": "...assistant reply...", "usage": { "total_tokens": 42 }, "latencyMs": 512, "providerId": "openai-main" }
```

### Supported Message Types (Inbound)
- `auth` – Authenticate with API key.
- `chat.completions` – Single-shot chat completion (non-streaming for now).
- `ping` – Liveness check (responds with `pong`).

### Outbound Types
- `auth.ok`
- `error` (fields: `code`, `message`, optional `requestId`)
- `chat.start`
- `chat.complete`
- `pong`

### Rate Limiting
WebSocket messages share per-connection tracking and enforce tier limits (RPS/RPM/RPD) similarly to REST endpoints. Exceeding limits yields:
```json
{ "type": "error", "code": "rate_limited", "message": "Rate limit exceeded" }
```

### Example Node Test Scripts
 See `dev/testWs.ts`:
 ```bash
 TEST_API_KEY=YOUR_KEY bun x tsx ./dev/testWs.ts
 ```
A REST streaming test can be performed with `curl` as shown above.

 ### Planned Extensions
 - Streaming partial responses via `chat.delta` frames
 - Multiplex provider admin actions over WS
 - Real-time usage and provider stats push updates

## Data Storage

The API server supports dual data storage modes with automatic failover:

### Redis Storage (Recommended)
- Primary storage method for production deployments
- Supports Redis Cloud and self-hosted Redis instances
- Automatic connection retry and error handling
- Faster access times and better scalability

### Filesystem Storage (Fallback)
- Automatic fallback when Redis is unavailable
- Stores data in JSON files (`providers.json`, `models.json`, `keys.json`)
- Suitable for development and single-instance deployments

### Configuration
Set `DATA_SOURCE_PREFERENCE=redis` or `DATA_SOURCE_PREFERENCE=filesystem` in your `.env` file. The system will automatically fall back to filesystem storage if Redis connection fails.

## Key Management & Tiers

*   API keys are managed in `keys.json` (filesystem) or Redis.
*   User tiers and their associated rate limits (RPS, RPM, RPD) and provider score preferences are defined in `tiers.json`.
*   The `generalAuthMiddleware` in `server.ts` handles initial API key validation, and specific middlewares in provider routes (`openai.ts`, etc.) or admin routes (`admin.ts`) enforce authentication and authorization.
*   `GET /v1/keys/me` returns usage and tier info for the current key (validates the key even if token usage is exhausted).
*   Default admin users can be auto-created using the `DEFAULT_ADMIN_USER_ID` and `DEFAULT_ADMIN_API_KEY` environment variables.

## Logging & Monitoring

*   **Console Logging**: Server startup, request information, and general operational logs.
*   **Error Logging**: Detailed errors are logged in JSON Lines format to:
    - Redis (if `ERROR_LOG_TO_REDIS=true` and Redis is available)
    - Filesystem fallback (`logs/api-error.jsonl`)
*   **Error Exclusions**: Configure `excluded-errors.json` to avoid counting known transient errors toward auto-disable logic.
*   **Provider Statistics**: Response times, error rates, and performance metrics are continuously tracked and stored.
*   **Request Tracking**: All API requests are logged with timestamps, response times, and usage statistics.

## Development Tools

### Mock Provider Server
- Full OpenAI-compatible mock server for testing
- Configurable response times, error rates, and behaviors
- Runtime configuration via REST endpoints
- Environment variable configuration support
- See `dev/MOCK_SERVER_CONFIG.md` for detailed usage

### Testing Scripts
- `dev/testApi.ts`: Main API integration testing
- `dev/testMockProvider.ts`: Mock provider functionality testing
- `dev/testSetup.ts`: Test environment setup and cleanup
- Automatic test data preservation and cleanup

## Contributing

me, myself, and i 

GG or owner of the fabled goldai (helped getting me into this space thats now dying)

## License

Elastic License 2.0
