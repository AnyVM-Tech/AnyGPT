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
└── server/             # CLI scripts (legacy, being migrated to API routes)
    ├── addProvider.ts  # Script to add/update providers
    └── generateApiKey.ts # Script to generate API keys
```

## Features

*   **Multi-Provider Support**: Integrates with various AI model providers (OpenAI, Anthropic, Gemini, Groq, OpenRouter, Ollama, etc.).
*   **Dual Data Storage**: Supports both Redis and filesystem-based data storage with automatic failover and preference configuration.
*   **Dynamic Model Management**: Automatically updates `models.json` with provider counts based on active providers in `providers.json`.
*   **OpenWebUI Compatibility**: `models.json` format is designed for compatibility with OpenWebUI.
*   **Environment-Driven Configuration**: Enable/disable specific provider routers via environment variables.
*   **Tier-Based Rate Limiting**: Implements RPS, RPM, RPD limits based on user tiers defined in `tiers.json`.
*   **API Key Management**: Generation and validation of user API keys with tier-based permissions.
*   **Provider Statistics & Scoring**: Tracks provider performance (response times, error rates, token speed) and calculates a score for intelligent routing.
*   **Error Handling & Logging**: Comprehensive error logging to both Redis and filesystem (`logs/api-error.jsonl`) with fallback support.
*   **Admin Endpoints**: Secure endpoints for managing providers and users.
*   **Development Testing Suite**: Comprehensive testing infrastructure with configurable mock providers.
*   **Mock Provider Server**: Full-featured mock AI provider for testing with configurable response times, error rates, and behaviors.

## Prerequisites

*   Node.js (version specified in `package.json` or higher)
*   pnpm (version specified in `package.json`)

## Setup

1.  **Clone the repository.**
2.  **Navigate to the `apps/api` directory:**
    ```bash
    cd apps/api
    ```
3.  **Install dependencies:**
    ```bash
    pnpm install
    ```
## Setup

1.  **Clone the repository.**
2.  **Navigate to the `apps/api` directory:**
    ```bash
    cd apps/api
    ```
3.  **Install dependencies:**
    ```bash
    pnpm install
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

5.  **Initial Data Files**: The server will attempt to create `providers.json`, `models.json`, and `keys.json` if they don't exist. The data will be stored in Redis if configured, with filesystem fallback.

## Running the Server

*   **Development Mode** (with hot-reloading via `tsx`):
    ```bash
    pnpm run dev
    ```
    This runs `server.ts` directly with TypeScript support.

*   **Production Build & Start:**
    ```bash
    # Build the TypeScript code
    pnpm run build
    
    # Start the compiled server
    pnpm start
    ```
    The build process outputs JavaScript files to `dist/` and the start script runs `./dist/server.js`.

## Testing

The project includes a comprehensive testing suite with both unit tests and integration tests using a configurable mock provider.

### Running Tests

*   **Full Test Suite** (recommended):
    ```bash
    pnpm test
    ```
    This runs the mock provider, API server, and test runner concurrently, then cleans up automatically.

*   **Individual Test Components**:
    ```bash
    # Run only the mock provider
    pnpm run test:mock
    
    # Run only the API server in test mode
    pnpm run test:dev
    
    # Run only the test scripts (requires servers to be running)
    pnpm run test:run
    ```

### Mock Provider Testing

The mock provider supports runtime configuration for realistic testing scenarios:

```bash
# Test the mock provider configuration
pnpm exec tsx ./dev/testMockProvider.ts

# Run the mock provider standalone
pnpm run test:mock
```

See `dev/MOCK_SERVER_CONFIG.md` for detailed documentation on configuring response times, error rates, and other mock behaviors.

## API Endpoints

The server exposes several sets of endpoints:

*   **Provider-Specific Endpoints** (e.g., `/openai/v1/chat/completions`, `/anthropic/v3/messages`):
    *   These mimic the native APIs of providers like OpenAI, Anthropic, Gemini, and Groq.
    *   Refer to the respective files in `routes/` for exact paths and request/response formats.
    *   Authentication: Typically via `Authorization: Bearer <YOUR_ANYGPT_API_KEY>` or provider-specific headers like `x-api-key` mapped to your AnyGPT key.
*   **Model Information Endpoints** (e.g., `/api/models`):
    *   `GET /api/models`: Lists available models from `models.json`.
    *   `POST /api/admin/models/refresh-provider-counts`: Manually triggers a refresh of provider counts in `models.json` (requires admin privileges).
*   **Admin Endpoints** (prefixed with `/api/admin`, require admin privileges):
    *   `POST /api/admin/providers`: Adds or updates a provider configuration in `providers.json` and fetches its models.
    *   `POST /api/admin/users/generate-key`: Generates a new API key for a user.

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
*   Default admin users can be auto-created using the `DEFAULT_ADMIN_USER_ID` and `DEFAULT_ADMIN_API_KEY` environment variables.

## Logging & Monitoring

*   **Console Logging**: Server startup, request information, and general operational logs.
*   **Error Logging**: Detailed errors are logged in JSON Lines format to:
    - Redis (if `ERROR_LOG_TO_REDIS=true` and Redis is available)
    - Filesystem fallback (`logs/api-error.jsonl`)
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