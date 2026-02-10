export const tps = [
  {
    "id": "openai-mock",
    "apiKey": "mock-api-key-for-testing",
    "provider_url": "http://localhost:3001/v1/chat/completions",
    "streamingCompatible": true,
    "models": {
      "gpt-3.5-turbo": {
        "id": "gpt-3.5-turbo",
        "token_generation_speed": 50,
        "response_times": [
          {
            "timestamp": 1756708660689,
            "response_time": 2333,
            "input_tokens": 8,
            "output_tokens": 20,
            "tokens_generated": 28,
            "provider_latency": 1933,
            "observed_speed_tps": 50,
            "apiKey": "test-key-for-mock-provider"
          }
        ],
        "errors": 7,
        "consecutive_errors": 0,
        "avg_response_time": 2333,
        "avg_provider_latency": 1933,
        "avg_token_speed": 50
      }
    },
    "avg_response_time": 2333,
    "avg_provider_latency": 1933,
    "errors": 7,
    "provider_score": 43,
    "disabled": false
  }
]
