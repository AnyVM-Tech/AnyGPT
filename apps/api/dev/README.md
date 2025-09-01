# AnyGPT Development and Testing

This directory contains development tools and test scripts for the AnyGPT API.

## Environment Configuration

The project uses different environment files for different scenarios:

- `.env` - Default development environment
- `.env.test` - Automated testing environment
- `.env.example` - Template with all available options documented

## Test Scripts

### Running Tests

```bash
# Run the full test suite (starts mock provider, API server, and runs tests)
pnpm test

# Run individual components
pnpm test:mock    # Start mock provider only
pnpm test:dev     # Start API server in test mode
pnpm test:run     # Run API tests (requires servers to be running)
pnpm test:ws      # Run WebSocket tests (requires servers to be running)
```

### Test Environment

When `NODE_ENV=test`, all scripts automatically load `.env.test` instead of `.env`. This ensures:

- Consistent test configuration
- Isolated test data
- Predictable mock provider behavior
- No interference with development settings

### Mock Provider

The mock provider (`mockProvider.ts`) simulates OpenAI-compatible streaming responses with configurable:

- Response delays and variance
- Error rates and timeout simulation
- Token generation speed
- Logging verbosity

All mock behavior is controlled via environment variables (see `.env.test` for examples).

## File Descriptions

- `mockProvider.ts` - Mock OpenAI-compatible server for testing
- `testApi.ts` - REST API test suite
- `testWs.ts` - WebSocket streaming test suite  
- `testSetup.ts` - Utilities for test configuration management
- `README.md` - This documentation

## Testing Workflow

1. The test suite automatically:
   - Backs up existing `providers.json` and `keys.json`
   - Creates test configuration with mock provider
   - Runs tests against the mock setup
   - Restores original configuration (preserving any new metrics)

2. Mock provider metrics (response times, error counts) are preserved and merged back into the original configuration

3. All test data uses isolated API keys and provider configurations

## Environment Variables

See `.env.example` for a complete list of configurable options. Key test-specific variables:

- `TEST_API_KEY` - API key for test requests
- `WS_URL` - WebSocket endpoint for streaming tests
- `MOCK_*` - Mock provider behavior configuration
- `ENABLE_*_ROUTES` - Router enabling/disabling for testing

## Debugging

Set `LOG_LEVEL=debug` and `MOCK_ENABLE_LOGS=true` in your test environment for detailed logging during test runs.