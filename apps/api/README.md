# AnyGPT API Server

This directory contains the backend API server for AnyGPT, built with HyperExpress on Node.js and TypeScript.

## Overview

The API server acts as a central gateway to various AI model providers. It manages API keys, handles request routing, provides rate limiting, logs errors, and dynamically updates model information.

## Project Structure

```
apps/api/
├── server.ts           # Main server entry point, initializes and runs the API
├── package.json        # Project dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── .env.example        # Example environment variables (create .env from this)
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
│   └── ...             # Potentially other provider-specific or utility routes
|
├── providers/          # Logic for interacting with specific AI provider APIs
│   ├── handler.ts      # Core message handling, provider selection, and stats updates
│   ├── interfaces.ts   # TypeScript interfaces for providers and models
│   ├── openai.ts       # OpenAI provider client
│   ├── gemini.ts       # Gemini provider client
│   └── ...             # Other provider client implementations
|
├── modules/            # Reusable modules for various functionalities
│   ├── dataManager.ts  # Manages loading and saving of JSON data files (models, providers, keys)
│   ├── modelUpdater.ts # Handles automatic updates to models.json based on provider data
│   ├── errorLogger.ts  # Centralized error logging to file (logs/api-error.jsonl)
│   ├── userData.ts     # Manages user API key generation, validation, and usage tracking
│   ├── compute.ts      # Computes provider statistics, scores, and applies EMA
│   ├── db.ts           # (Potentially for future database interactions - currently Redis example)
│   └── typeguards.ts   # TypeScript type guards
|
├── logs/               # Directory for log files
│   └── api-error.jsonl # Detailed error logs in JSON Lines format
|
├── dev/                # Development related utilities
│   └── testApi.ts      # Script for testing API endpoints
|
└── server/             # CLI scripts (some functionality being migrated to API routes)
    ├── addProvider.ts  # Script to add/update providers (refactored into an API module)
    └── ...
```

## Features

*   **Multi-Provider Support**: Integrates with various AI model providers (OpenAI, Anthropic, Gemini, Groq, etc.).
*   **Dynamic Model Management**: Automatically updates `models.json` with provider counts based on active providers in `providers.json`.
*   **OpenWebUI Compatibility**: `models.json` format is designed for compatibility.
*   **Environment-Driven Configuration**: Enable/disable specific provider routers via environment variables.
*   **Tier-Based Rate Limiting**: Implements RPS, RPM, RPD limits based on user tiers defined in `tiers.json`.
*   **API Key Management**: Generation and validation of user API keys.
*   **Provider Statistics & Scoring**: Tracks provider performance (response times, error rates, token speed) and calculates a score for intelligent routing.
*   **Error Handling & Logging**: Comprehensive error logging to `logs/api-error.jsonl` and standardized client error responses.
*   **Admin Endpoints**: Secure endpoints for managing providers and users.

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
4.  **Create a `.env` file** by copying `.env.example` (if it exists, otherwise create one) and populate it with your API keys and other configurations. Key environment variables include:
    *   `PORT`: Port for the API server (default: 3000).
    *   `PROVIDER_API_KEY_OPENAI_DEFAULT`: API key for your OpenAI account (example, follow pattern for other providers like `PROVIDER_API_KEY_ANTHROPIC_DEFAULT`, etc., if the provider's primary key is set in `providers.json` this is a fallback or override).
    *   `ENABLE_OPENAI_ROUTES`: Set to `true` or `false` to enable/disable OpenAI routes (default: `true`).
    *   `ENABLE_ANTHROPIC_ROUTES`: Set to `true` or `false` (default: `true`).
    *   `ENABLE_GEMINI_ROUTES`: Set to `true` or `false` (default: `true`).
    *   `ENABLE_GROQ_ROUTES`: Set to `true` or `false` (default: `true`).
    *   `ENABLE_ADMIN_ROUTES`: Set to `true` or `false` (default: `true`).
    *   `ENABLE_MODELS_ROUTES`: Set to `true` or `false` (default: `true`).

    Refer to `server.ts` for the exact `ENABLE_<ROUTER_NAME>_ROUTES` variable names.

5.  **Initial Data Files**: The server will attempt to create `providers.json`, `models.json`, and `keys.json` if they don't exist with default structures. You will need to populate `providers.json` with your provider configurations and `keys.json` with initial admin keys if necessary.

## Running the Server

*   **Development Mode (with hot-reloading via `tsx`):
    ```bash
    pnpm run dev
    ```
    This command runs `server.ts` directly.

*   **Production Build & Start:**
    1.  Build the TypeScript code:
        ```bash
        pnpm run build
        ```
        This will output JavaScript files to `dist/api`.
    2.  Run the built server (you might need to adjust the start script in `package.json` or use `node dist/api/server.js`):
        The current `pnpm start` script in `package.json` points to `tsx routes/openai.ts` which is likely for isolated testing of OpenAI routes. For production, you should run the main `server.ts` (or its compiled version `dist/api/server.js`).
        **Recommended update to `package.json` for production start:**
        ```json
        "scripts": {
          // ... other scripts
          "start": "node ../../dist/api/server.js", // If running from apps/api
          "dev": "tsx server.ts",
          // ...
        }
        ```
        Then run:
        ```bash
        pnpm start
        ```

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

## Key Management & Tiers

*   API keys are managed in `keys.json`.
*   User tiers and their associated rate limits (RPS, RPM, RPD) and provider score preferences are defined in `tiers.json`.
*   The `generalAuthMiddleware` in `server.ts` handles initial API key validation, and specific middlewares in provider routes (`openai.ts`, etc.) or admin routes (`admin.ts`) enforce authentication and authorization.

## Logging

*   Server startup and request information are logged to the console.
*   Detailed errors are logged in JSON Lines format to `logs/api-error.jsonl`. Each entry includes a timestamp, request details (if applicable), error message, stack trace, and other context.

## Contributing

(Add guidelines for contributing if this is an open project).

## License

(Specify the license for the project).