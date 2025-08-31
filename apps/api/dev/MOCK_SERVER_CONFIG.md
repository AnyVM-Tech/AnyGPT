# Mock Server Configuration Guide

The mock server now supports runtime configuration of response times, error rates, and other behaviors to simulate realistic AI provider conditions.

## Configuration Endpoints

### GET /mock/config
Returns the current mock server configuration.

**Example:**
```bash
curl http://localhost:3001/mock/config
```

**Response:**
```json
{
  "baseDelay": 150,
  "delayVariance": 100,
  "errorRate": 0.1,
  "timeoutRate": 0.02,
  "tokenSpeed": 30,
  "enableLogs": true
}
```

### POST /mock/config
Updates the mock server configuration. All parameters are optional.

**Example:**
```bash
curl -X POST http://localhost:3001/mock/config \
  -H "Content-Type: application/json" \
  -d '{
    "errorRate": 0.2,
    "baseDelay": 200,
    "delayVariance": 150,
    "enableLogs": true
  }'
```

**Parameters:**
- `baseDelay` (number): Base response delay in milliseconds (default: 150)
- `delayVariance` (number): Random variance added to base delay (default: 100)
- `errorRate` (number): Probability of returning an error (0-1, default: 0.1)
- `timeoutRate` (number): Probability of timing out (0-1, default: 0.02)
- `tokenSpeed` (number): Simulated tokens per second for response timing (default: 30)
- `enableLogs` (boolean): Enable/disable console logging (default: true)

### POST /mock/reset
Resets all configuration to default values.

**Example:**
```bash
curl -X POST http://localhost:3001/mock/reset
```

## Environment Variables

You can also configure the mock server using environment variables:

```bash
MOCK_BASE_DELAY=200
MOCK_DELAY_VARIANCE=100
MOCK_ERROR_RATE=0.15
MOCK_TIMEOUT_RATE=0.05
MOCK_TOKEN_SPEED=25
MOCK_ENABLE_LOGS=true
```

## Simulated Behaviors

### Response Times
- Calculated based on `tokenSpeed` for realistic token generation timing
- Additional processing delay based on `baseDelay` ± `delayVariance`
- Longer responses take proportionally longer time

### Error Simulation
The mock server can simulate various error types:
- **Rate Limiting (429)**: "Rate limit exceeded"
- **Server Errors (500)**: "Internal server error"
- **Service Unavailable (503)**: "Service temporarily unavailable"
- **Bad Request (400)**: "Invalid request format"

### Timeout Simulation
Based on `timeoutRate`, the server may not respond at all to simulate network timeouts.

## Testing Scenarios

### High Latency Testing
```bash
curl -X POST http://localhost:3001/mock/config \
  -H "Content-Type: application/json" \
  -d '{"baseDelay": 2000, "delayVariance": 1000, "tokenSpeed": 10}'
```

### High Error Rate Testing
```bash
curl -X POST http://localhost:3001/mock/config \
  -H "Content-Type: application/json" \
  -d '{"errorRate": 0.5, "timeoutRate": 0.1}'
```

### Fast Response Testing
```bash
curl -X POST http://localhost:3001/mock/config \
  -H "Content-Type: application/json" \
  -d '{"baseDelay": 50, "delayVariance": 25, "tokenSpeed": 100}'
```

## Usage in Tests

Run the enhanced test to see configuration in action:
```bash
pnpm exec tsx ./dev/testMockProvider.ts
```

This test will:
1. Check current configuration
2. Increase error rate to 30%
3. Send multiple requests to observe errors
4. Reset configuration to defaults
5. Verify normal operation