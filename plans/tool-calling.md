# Tool calling + reasoning effort manual test matrix

## Chat completions (HTTP)

### Streaming tool call (OpenAI-compatible)
Request:
```json
{
  "model": "gpt-4.1",
  "stream": true,
  "messages": [{"role": "user", "content": "Call get_time for NYC"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get time for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning_effort": "low"
}
```
Expect:
- SSE deltas include `tool_calls` in `choices[0].delta` when invoked.
- Final chunk has `finish_reason` = `tool_calls` when a tool call is emitted.

### Non-streaming tool call (OpenAI-compatible)
Request:
```json
{
  "model": "gpt-4.1",
  "messages": [{"role": "user", "content": "Call get_time for NYC"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get time for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": {"effort": "low"}
}
```
Expect:
- `choices[0].message.tool_calls` present when the tool is invoked.
- `choices[0].finish_reason` = `tool_calls`.

## Responses API (HTTP)

### Responses non-streaming
Request:
```json
{
  "model": "gpt-4.1",
  "input": "Call get_time for NYC",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get time for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning_effort": "low"
}
```
Expect:
- `output[0].content` includes an item with `type: "tool_calls"` and `tool_calls`.
- `status` reflects tool call completion state (if returned by upstream).

### Responses streaming
Request:
```json
{
  "model": "gpt-4.1",
  "stream": true,
  "input": "Call get_time for NYC",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get time for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": {"effort": "low"}
}
```
Expect:
- Raw upstream SSE is passed through when available.
- Fallback streaming emits `response.output_text.delta` events; final `response.completed` includes tool call content if returned by provider.

## OpenRouter route

### Non-streaming tool call
Request:
```json
{
  "model": "openrouter/auto",
  "messages": [{"role": "user", "content": "Call get_time for NYC"}],
  "tools": [{"type": "function", "function": {"name": "get_time", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
  "tool_choice": "auto",
  "reasoning_effort": "low"
}
```
Expect:
- `choices[0].message.tool_calls` present when invoked.
- `choices[0].finish_reason` = `tool_calls`.

## WebSocket

### Streaming tool call
Send:
```json
{
  "type": "chat.completions",
  "model": "gpt-4.1",
  "stream": true,
  "messages": [{"role": "user", "content": "Call get_time for NYC"}],
  "tools": [{"type": "function", "function": {"name": "get_time", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
  "tool_choice": "auto",
  "reasoning_effort": "low"
}
```
Expect:
- `chat.completion.chunk` deltas contain `tool_calls` when the tool triggers.
- Final `chat.complete` includes `tool_calls` and `finish_reason` = `tool_calls`.
