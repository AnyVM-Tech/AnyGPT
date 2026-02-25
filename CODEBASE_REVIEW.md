# AnyGPT Codebase Review & Improvement Suggestions

## Architecture Summary

AnyGPT is a multi-provider AI API gateway that presents an OpenAI-compatible interface while routing requests across multiple backend providers (OpenAI, Gemini, Imagen, OpenRouter, Deepseek). It features:
- Provider health tracking, scoring, and auto-disable/re-enable
- Tiered API key management with rate limiting
- Redis + filesystem dual persistence via `DataManager`
- Streaming/passthrough support
- Worker thread offloading for metrics computation

---

## Critical Issues

### 1. Massive code duplication between `handler.ts` and `routes/openai.ts`

**Files:** [`handler.ts`](apps/api/providers/handler.ts) and [`routes/openai.ts`](apps/api/routes/openai.ts)

Token estimation functions are **fully duplicated** across both files:
- `readEnvNumber()` — identical in both files
- `estimateTokensFromBase64Payload()` — identical  
- `estimateTokensFromDataUrl()` — identical
- `estimateTokensFromText()` — nearly identical (handler's version has breakdown variant)
- `estimateTokensFromContent()` — similar logic, different signatures
- `BASE64_DATA_URL_GLOBAL` regex — identical
- `IMAGE_INPUT_TOKENS_PER_KB`, `AUDIO_INPUT_TOKENS_PER_KB`, etc. — identical env reads

**Suggestion:** Extract all token estimation into a shared `modules/tokenEstimation.ts` module. Both files should import from there.

### 2. Duplicate error classification logic

**Files:** [`handler.ts`](apps/api/providers/handler.ts) and [`routes/openai.ts`](apps/api/routes/openai.ts)

Rate-limit detection is duplicated:
- `isRateLimitOrQuotaError()` in [`handler.ts:292`](apps/api/providers/handler.ts:292)
- `isRateLimitError()` in [`routes/openai.ts:45`](apps/api/routes/openai.ts:45)

Similarly, `extractRetryAfterMs()` in handler and `extractRetryAfterSeconds()` in routes do the same thing but return different units (ms vs seconds).

**Suggestion:** Centralize error classification and retry-after parsing into `modules/errorClassification.ts`.

### 3. Duplicate SSE parsing logic in `openai.ts` provider

**File:** [`openai.ts`](apps/api/providers/openai.ts)

The SSE chunk consumer function (`consumeSseChunk`) is copy-pasted **three times** within `sendMessageStream()` (lines ~755, ~822, ~874). Each copy is identical logic for parsing SSE `data:` lines from a buffer.

**Suggestion:** Extract into a private method or utility:
```typescript
private createSseConsumer(): { consume: (rawChunk: any) => string[]; } { ... }
```

### 4. Error-to-status-code mapping is duplicated across route handlers

**File:** [`routes/openai.ts`](apps/api/routes/openai.ts)

The massive `catch` block that maps error messages to HTTP status codes (lines ~2042-2114) is **duplicated nearly identically** for:
- `/chat/completions` (lines 2042-2114)
- `/responses` (lines 2436-2502)
- `/deployments/:deploymentId/chat/completions` (lines 2678-2712)

**Suggestion:** Extract into a shared function:
```typescript
function mapErrorToHttpResponse(error: any): { statusCode: number; message: string; reference?: string }
```

---

## Design Improvements

### 5. `handler.ts` — `handleMessages` and `handleStreamingMessages` share ~80% logic

**File:** [`handler.ts`](apps/api/providers/handler.ts:670)

Both methods perform identical:
- Capability refresh + validation
- API key validation
- Provider candidate preparation
- Capability filtering
- Input token estimation + limit checking
- Provider loop with cooldown/blocked-key tracking
- Provider config resolution and class instantiation
- Stats update and error handling

The only difference is whether they call `sendMessage` or iterate `sendMessageStream`.

**Suggestion:** Extract the shared setup into a private method like `prepareRequest()` that returns `{ candidateProviders, inputTokenEstimate, ... }`, and refactor the provider attempt loop into a generic method that accepts a callback for the actual API call.

### 6. Provider ID matching uses fragile string `includes()` checks

**File:** [`handler.ts`](apps/api/providers/handler.ts:182)

Provider class resolution relies on `providerId.includes('openai')`, `providerId.includes('gemini')`, etc. This is duplicated in both `initializeHandlerData()` (line 182) and `ensureProviderConfig()` (line 409).

**Risks:**
- A provider named `"my-openai-clone"` would match `openai`
- Order matters: `"openai-gemini"` would match `openai` first
- Adding new provider types requires editing two places

**Suggestion:** Use a provider type registry pattern:
```typescript
const PROVIDER_REGISTRY: Array<{ match: (id: string) => boolean; class: typeof IAIProvider; }> = [
  { match: id => id.includes('openrouter'), class: OpenRouterAI },
  { match: id => id.includes('deepseek'), class: DeepseekAI },
  { match: id => id.includes('imagen'), class: GeminiAI },
  { match: id => id.includes('gemini') || id === 'google', class: GeminiAI },
  { match: id => id.includes('openai'), class: OpenAI },
];
```

### 7. `DataManager` has excessive console logging

**File:** [`dataManager.ts`](apps/api/modules/dataManager.ts)

Every `load()` and `save()` call produces multiple console.log lines. Under load with 5-second cache TTL, this generates enormous log volume. Example from a single `load('providers')` call:
```
[DataManager] Data loaded successfully from Redis for: providers
[DataManager] Data saved successfully to Redis for: providers
[DataManager] Data saved successfully to Filesystem for: providers
```

**Suggestion:** Use the existing `logger` module with appropriate log levels. Only log at `debug` level for routine operations; keep `info` for startup/migration only.

### 8. `openai.ts` routes file is 3520 lines — needs decomposition

**File:** [`routes/openai.ts`](apps/api/routes/openai.ts)

This single file contains:
- Auth middleware
- Rate limit middleware  
- Token estimation utilities
- Image fetch/proxy logic (SSRF protection, DNS resolution)
- Multipart parsing
- Chat completions route
- Responses API route
- Interactions routes
- Azure compatibility route
- TTS/STT proxy routes
- Image generation route
- Video generation route
- Embeddings route
- Image edits route
- Audio voice/model listing

**Suggestion:** Split into:
- `routes/openai/chat.ts` — chat completions
- `routes/openai/responses.ts` — responses API
- `routes/openai/media.ts` — TTS, STT, image gen, video gen, image edits
- `routes/openai/embeddings.ts` — embeddings
- `routes/openai/interactions.ts` — interactions
- `modules/imageProxy.ts` — image fetch, SSRF protection, multipart parsing

---

## Type Safety Improvements

### 9. Excessive `any` casting in `handler.ts`

**File:** [`handler.ts`](apps/api/providers/handler.ts)

Several places use `(modelData as any)?.disabled`, `(modelData as any)?.capability_skips`, etc. when the [`Model`](apps/api/providers/interfaces.ts:17) interface already defines these fields (though some are optional).

**Suggestion:** Use proper type narrowing instead of `as any`:
```typescript
const modelData = provider.models?.[modelId];
if (modelData?.disabled) return false;
const skips = modelData?.capability_skips;
```

### 10. Duplicate interface definitions across files

**Files:** [`interfaces.ts`](apps/api/providers/interfaces.ts) and [`dataManager.ts`](apps/api/modules/dataManager.ts)

`ModelDefinition` is defined in both files with slightly different shapes:
- `interfaces.ts`: fields are optional (`object?`, `created?`, etc.)
- `dataManager.ts`: fields are required (`object: "model"`, `created: number`, etc.)

Similarly, `UserData` is defined in `interfaces.ts`, `dataManager.ts`, and imported from `userData.ts`.

**Suggestion:** Consolidate into a single `types/` directory with canonical definitions.

---

## Security Improvements

### 11. API keys appear in Gemini URLs

**File:** [`gemini.ts`](apps/api/providers/gemini.ts:137)

API keys are passed as query parameters:
```typescript
const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(this.apiKey)}`;
```

While this is Gemini's API design, the keys will appear in:
- Access logs
- Error messages (line 142: `throw new Error(... ${responseText})`)
- Network monitoring tools

**Suggestion:** At minimum, redact the API key from error messages before re-throwing. Consider logging just the key prefix for debugging.

### 12. `redaction.ts` hash secret defaults to a static string

**File:** [`redaction.ts`](apps/api/modules/redaction.ts:3)

```typescript
const DEFAULT_HASH_SECRET = process.env.API_KEY_HASH_SECRET || 'anygpt-api';
```

If `API_KEY_HASH_SECRET` is not set, all deployments use the same HMAC secret, making key hashes predictable/reversible via rainbow tables.

**Suggestion:** Log a warning at startup if no secret is configured, or generate a random one on first run and persist it.

---

## Performance Improvements

### 13. `videoRequestCache` has no eviction

**File:** [`routes/openai.ts`](apps/api/routes/openai.ts:334)

```typescript
const videoRequestCache = new Map<string, { apiKey: string; baseUrl: string; expiresAt: number }>();
```

Entries are set with TTL but only evicted on access (`getVideoRequestCache` deletes expired). If many video requests are made and never polled, this Map grows unbounded.

**Suggestion:** Add periodic eviction (e.g., every 5 minutes) or use an LRU cache with a maximum size.

### 14. `providerCooldowns` Map has no eviction

**File:** [`handler.ts`](apps/api/providers/handler.ts:68)

```typescript
const providerCooldowns = new Map<string, number>();
```

Entries are only removed when checked and found expired. Over time with many unique API keys this map grows.

**Suggestion:** Periodically sweep expired entries or use a bounded cache.

### 15. `DataManager.getDataSignature()` serializes entire models payload

**File:** [`dataManager.ts`](apps/api/modules/dataManager.ts:550)

```typescript
private getDataSignature(data: unknown): string {
    return JSON.stringify(data);
}
```

For the models file which can be large, this serializes the entire payload just for a change-detection check. This runs on every `load()`.

**Suggestion:** Use a fast hash (e.g., `crypto.createHash('md5')`) on the serialized data, or track a simpler version counter.

### 16. `inlineImageUrls` processes images sequentially

**File:** [`routes/openai.ts`](apps/api/routes/openai.ts:1222)

```typescript
for (const msg of messages) {
    for (const part of msg.content) {
        // Sequential fetch for each image
        const result = await fetchImageAsDataUrl(part.image_url.url, ...);
    }
}
```

Each image URL is fetched sequentially. With multiple images in a conversation, this adds latency.

**Suggestion:** Collect all image URLs first, then `Promise.all()` the fetches.

---

## Reliability Improvements

### 17. `handleStreamingMessages` simulated-stream fallback recurses into `handleMessages`

**File:** [`handler.ts`](apps/api/providers/handler.ts:1108)

When a provider doesn't support streaming:
```typescript
const result = await this.handleMessages(messages, modelId, apiKey);
```

This re-runs the entire provider selection, auth validation, and attempt loop — potentially picking a different provider. It also double-counts usage since both `handleMessages` and the streaming path will call `updateUserTokenUsage`.

**Suggestion:** Instead of calling `handleMessages`, just call `providerInstance.sendMessage()` directly on the same provider and emit simulated chunks from the result.

### 18. No timeout on worker thread jobs

**File:** [`workerPool.ts`](apps/api/modules/workerPool.ts:93)

```typescript
return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    w.postMessage(payload);
});
```

If the worker hangs, this promise never resolves. The `jobs` map will grow and the calling code will hang.

**Suggestion:** Add a timeout (e.g., 5s) that rejects the promise and falls back to inline computation.

### 19. `updateStatsInBackground` fire-and-forgets without tracking

**File:** [`handler.ts`](apps/api/providers/handler.ts:1167)

In the streaming path, stats are updated via:
```typescript
this.updateStatsInBackground(providerId, modelId, responseEntry, false);
```

This is a fire-and-forget `async` call. If it throws, it's caught internally but the error is only logged. Under heavy load, many concurrent `updateWithLock` calls could create Redis contention.

**Suggestion:** Consider batching stats updates or using a queue to serialize them.

---

## Minor Code Quality Issues

### 20. Unused variable `_alpha` parameter

**File:** [`compute.ts`](apps/api/modules/compute.ts:68)

```typescript
export function computeProviderStatsWithEMA(providerData: Provider, _alpha: number): void {
```

The `_alpha` parameter is never used in the function body. The function computes simple averages, not EMA.

**Suggestion:** Either implement EMA as the function name suggests, or rename the function and remove the unused parameter.

### 21. `shouldUseResponsesApi` has overly broad matching

**File:** [`openai.ts`](apps/api/providers/openai.ts:127)

```typescript
private shouldUseResponsesApi(modelId: string, force?: boolean): boolean {
    // ...
    return normalized.includes('pro');
}
```

The final fallback `normalized.includes('pro')` would match any model with "pro" in its name (e.g., `gpt-4-pro-vision`, `llama-pro`, etc.), forcing them all to use the Responses API.

**Suggestion:** Be more specific: check for exact model families that require Responses API.

### 22. `gemini.ts` constructor only takes `apiKey` but callers pass `modelId`

**File:** [`gemini.ts`](apps/api/providers/gemini.ts:353)

```typescript
constructor(apiKey: string) {
```

But in [`handler.ts`](apps/api/providers/handler.ts:753), it's called with:
```typescript
args[1] = modelId; // This argument is ignored by the constructor
```

The `modelId` is set in `args[1]` but `GeminiAI`'s constructor only reads `args[0]`. The model ID comes from `message.model.id` inside `sendMessage`. The extra arg is silently ignored.

**Suggestion:** Either accept `modelId` in the constructor or remove the `args[1] = modelId` assignment to avoid confusion.

---

## Summary Table

| # | Category | Severity | Effort |
|---|----------|----------|--------|
| 1 | Duplication | 🔴 High | Medium |
| 2 | Duplication | 🟡 Medium | Low |
| 3 | Duplication | 🟡 Medium | Low |
| 4 | Duplication | 🟡 Medium | Low |
| 5 | Design | 🟡 Medium | High |
| 6 | Design | 🟡 Medium | Medium |
| 7 | Ops/Logging | 🟡 Medium | Low |
| 8 | Design | 🔴 High | High |
| 9 | Type Safety | 🟢 Low | Low |
| 10 | Type Safety | 🟡 Medium | Medium |
| 11 | Security | 🟡 Medium | Low |
| 12 | Security | 🟡 Medium | Low |
| 13 | Performance | 🟢 Low | Low |
| 14 | Performance | 🟢 Low | Low |
| 15 | Performance | 🟢 Low | Low |
| 16 | Performance | 🟡 Medium | Low |
| 17 | Reliability | 🟡 Medium | Medium |
| 18 | Reliability | 🟡 Medium | Low |
| 19 | Reliability | 🟢 Low | Medium |
| 20 | Code Quality | 🟢 Low | Low |
| 21 | Code Quality | 🟡 Medium | Low |
| 22 | Code Quality | 🟢 Low | Low |
