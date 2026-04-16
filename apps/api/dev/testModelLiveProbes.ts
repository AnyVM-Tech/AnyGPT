import { dataManager, LoadedProviders, LoadedProviderData, ModelsFileStructure } from '../modules/dataManager.js';
import { ModelCapability, IMessage } from '../providers/interfaces.js';
import { OpenAI } from '../providers/openai.js';
import { GeminiAI } from '../providers/gemini.js';
import { ImagenAI } from '../providers/imagen.js';
import { DeepseekAI } from '../providers/deepseek.js';
import { OpenRouterAI } from '../providers/openrouter.js';
import { checkKeyHealth } from '../modules/keyChecker.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Simple live probe for a representative request per capability for each model.
// It picks the first available provider for the model (disabled providers are skipped) and
// attempts minimal payloads: text, image input, image output, audio input, audio output,
// tool calling, streaming, realtime. Results update models.json `capabilities` and persist unsupported
// capability skips in logs/probe-tested.json (no tested_capabilities persisted).
//
// Run (prefer Node 20/22 per engines):
//   cd apps/api && bun x tsx ./dev/testModelLiveProbes.ts
//
// This will issue real API calls using keys from providers.json. Use cautiously to avoid quota use.

// Tunables (override via env):
//   CAP_TEST_TIMEOUT_MS: per-call timeout
//   CAP_TEST_MAX_MODELS: limit how many models to probe
//   CAP_TEST_STOP_ON_FAIL: if "1", stop entire run on first failure
//   CAP_TEST_ALL_CAPS: if "0", only probe models with no declared caps (text only); default probes missing caps
//   CAP_TEST_RETRIES: number of retries for transient failures (default: 2)
//   CAP_TEST_RETRY_BACKOFF_MS: base backoff between retries
//   CAP_TEST_USE_PROBE_LOG: if "0", ignore logs/probe-errors.jsonl
//   CAP_TEST_KEYCHECK_CONCURRENCY: concurrent key checks (default: 8)
//   CAP_TEST_OPENROUTER_CONCURRENCY: cap concurrent OpenRouter calls (default: 1)
//   CAP_TEST_OPENROUTER_DELAY_MS: delay after each OpenRouter call (default: 250)
//   CAP_TEST_PROVIDER_CONCURRENCY: cap concurrent calls per provider (default: 1)
//   CAP_TEST_PROVIDER_COOLDOWN_MS: delay between calls per provider (default: 500)
//   CAP_TEST_SERVER_ERROR_WAIT_MS: base cooldown for server_error responses (default: 2000)
//   CAP_TEST_SERVER_ERROR_BACKOFF_MAX: max backoff steps for server_error (default: 4)
//   CAP_TEST_SERVER_ERROR_JITTER_MS: jitter for server_error cooldown (default: 250)
//   CAP_TEST_MAX_SERVER_ERROR_PROVIDERS: limit provider rotations on server errors (default: 8, 0 = unlimited)
//   CAP_TEST_MAX_SERVER_ERROR_RETRIES: per-model/test server error retries before assuming unsupported (default: 10)
//   CAP_TEST_MAX_RATE_LIMIT_TIMEOUT_RETRIES: per-model/test provider switches on rate limit/timeout before assuming unsupported (default: 10)
//   CAP_TEST_RATE_LIMIT_WAIT_MS: base wait for rate limits (default: 15000)
//   CAP_TEST_SKIP_TESTED_OK: if "0", re-test models even if probe-tested has ok results (default: 1)
//   CAP_TEST_PROVIDER_FILTER: comma-separated provider id substring(s) to probe (e.g. "openai,openrouter")
//   CAP_TEST_PROVIDER_FAMILY: comma-separated provider family names to probe (e.g. "openai,gemini,openrouter")
//   CAP_TEST_MODEL_FILTER: comma-separated model id substring(s) to probe (e.g. "gpt-5.4,gpt-5.2")
//   CAP_TEST_API_KEY: inject a temporary OpenAI-compatible provider for the selected model filter(s)
//   CAP_TEST_PROVIDER_URL: provider URL for the injected provider (defaults to OpenAI chat completions)
//   CAP_TEST_PROVIDER_ID: provider id for the injected provider (default: openai-probe)
//   CAP_TEST_KEYCHECK_ONLY: if "1", only validate provider keys/quotas and update providers.json (skip model probes)
const REQUEST_TIMEOUT_MS = Number(process.env.CAP_TEST_TIMEOUT_MS ?? 15000);
const IMAGE_TIMEOUT_MS = Number(process.env.CAP_TEST_IMAGE_TIMEOUT_MS ?? Math.max(REQUEST_TIMEOUT_MS, 30000));
const AUDIO_TIMEOUT_MS = Number(process.env.CAP_TEST_AUDIO_TIMEOUT_MS ?? REQUEST_TIMEOUT_MS);
const MAX_MODELS = Number.isFinite(Number(process.env.CAP_TEST_MAX_MODELS))
  ? Number(process.env.CAP_TEST_MAX_MODELS)
  : Infinity;
const STOP_ON_FAIL = process.env.CAP_TEST_STOP_ON_FAIL === '1';
const PROBE_CONCURRENCY = Math.max(1, Number(process.env.CAP_TEST_CONCURRENCY ?? 6));
const KEYCHECK_CONCURRENCY = Math.max(1, Number(process.env.CAP_TEST_KEYCHECK_CONCURRENCY ?? 8));
const TEST_ALL_CAPS = process.env.CAP_TEST_ALL_CAPS !== '0';
const MAX_RETRIES = Math.max(0, Number(process.env.CAP_TEST_RETRIES ?? 2));
const RETRY_BACKOFF_MS = Math.max(0, Number(process.env.CAP_TEST_RETRY_BACKOFF_MS ?? 750));
const RATE_LIMIT_WAIT_MS = Math.max(0, Number(process.env.CAP_TEST_RATE_LIMIT_WAIT_MS ?? 15000));
const TIMEOUT_WAIT_MS = Math.max(0, Number(process.env.CAP_TEST_TIMEOUT_WAIT_MS ?? 500));
const RATE_LIMIT_BACKOFF_MAX = Math.max(0, Number(process.env.CAP_TEST_RATE_LIMIT_BACKOFF_MAX ?? 6));
const RATE_LIMIT_JITTER_MS = Math.max(0, Number(process.env.CAP_TEST_RATE_LIMIT_JITTER_MS ?? 250));
const OPENROUTER_CONCURRENCY = Math.max(1, Number(process.env.CAP_TEST_OPENROUTER_CONCURRENCY ?? 1));
const OPENROUTER_DELAY_MS = Math.max(0, Number(process.env.CAP_TEST_OPENROUTER_DELAY_MS ?? 1000));
const PROVIDER_CONCURRENCY = Math.max(1, Number(process.env.CAP_TEST_PROVIDER_CONCURRENCY ?? 1));
const PROVIDER_COOLDOWN_MS = Math.max(0, Number(process.env.CAP_TEST_PROVIDER_COOLDOWN_MS ?? 500));
const SERVER_ERROR_WAIT_MS = Math.max(0, Number(process.env.CAP_TEST_SERVER_ERROR_WAIT_MS ?? 2000));
const SERVER_ERROR_BACKOFF_MAX = Math.max(0, Number(process.env.CAP_TEST_SERVER_ERROR_BACKOFF_MAX ?? 4));
const SERVER_ERROR_JITTER_MS = Math.max(0, Number(process.env.CAP_TEST_SERVER_ERROR_JITTER_MS ?? 250));
const MAX_SERVER_ERROR_PROVIDERS = Math.max(0, Number(process.env.CAP_TEST_MAX_SERVER_ERROR_PROVIDERS ?? 8));
const MAX_SERVER_ERROR_RETRIES = Math.max(0, Number(process.env.CAP_TEST_MAX_SERVER_ERROR_RETRIES ?? 10));
const MAX_RATE_LIMIT_TIMEOUT_RETRIES = Math.max(0, Number(process.env.CAP_TEST_MAX_RATE_LIMIT_TIMEOUT_RETRIES ?? 10));
const USE_PROBE_LOG = process.env.CAP_TEST_USE_PROBE_LOG !== '0';
const MAX_PROBE_LOG_LINES = Math.max(0, Number(process.env.CAP_TEST_PROBE_LOG_LINES ?? 20000));
const SKIP_TESTED_OK = process.env.CAP_TEST_SKIP_TESTED_OK !== '0';
const AUDIO_VOICE = process.env.CAP_TEST_AUDIO_VOICE ?? 'alloy';
const AUDIO_FORMAT = process.env.CAP_TEST_AUDIO_FORMAT ?? 'wav';
const KEYCHECK_ONLY = process.env.CAP_TEST_KEYCHECK_ONLY === '1';
const args = process.argv.slice(2);
const apiKeyArg = args.find((arg) => arg.startsWith('--api-key='));
const modelFilterArg = args.find((arg) => arg.startsWith('--models=') || arg.startsWith('--model='));
const providerIdArg = args.find((arg) => arg.startsWith('--provider-id='));
const providerUrlArg = args.find((arg) => arg.startsWith('--provider-url='));
const providerFilterArg = args.find((arg) => arg.startsWith('--providers=') || arg.startsWith('--provider='));
const providerFamilyArg = args.find((arg) => arg.startsWith('--provider-family=') || arg.startsWith('--provider-families=') || arg.startsWith('--families='));
const EXPLICIT_API_KEY = apiKeyArg
  ? apiKeyArg.split('=')[1]
  : (process.env.CAP_TEST_API_KEY ?? '');
const MODEL_FILTER_RAW = modelFilterArg
  ? modelFilterArg.split('=')[1]
  : (process.env.CAP_TEST_MODEL_FILTER ?? process.env.CAP_TEST_MODELS ?? '');
const EXPLICIT_PROVIDER_ID = providerIdArg
  ? providerIdArg.split('=')[1]
  : (process.env.CAP_TEST_PROVIDER_ID ?? 'openai-probe');
const EXPLICIT_PROVIDER_URL = providerUrlArg
  ? providerUrlArg.split('=')[1]
  : (process.env.CAP_TEST_PROVIDER_URL ?? 'https://api.openai.com/v1/chat/completions');
const PROVIDER_FILTER_RAW = providerFilterArg
  ? providerFilterArg.split('=')[1]
  : (process.env.CAP_TEST_PROVIDER_FILTER ?? process.env.CAP_TEST_PROVIDERS ?? '');
const PROVIDER_FAMILY_RAW = providerFamilyArg
  ? providerFamilyArg.split('=')[1]
  : (process.env.CAP_TEST_PROVIDER_FAMILY ?? process.env.CAP_TEST_PROVIDER_FAMILIES ?? '');
const MODEL_FILTERS = parseList(MODEL_FILTER_RAW);
const PROVIDER_FILTERS = parseList(PROVIDER_FILTER_RAW);
const PROVIDER_FAMILIES = parseList(PROVIDER_FAMILY_RAW);
const configuredLogDirectory = (process.env.ANYGPT_LOG_DIR || '').trim();
const LOG_DIRECTORY = configuredLogDirectory
  ? path.resolve(configuredLogDirectory)
  : path.resolve('logs');
const PROBE_LOG_PATH = path.join(LOG_DIRECTORY, 'probe-errors.jsonl');
const PROBE_TESTED_PATH = path.join(LOG_DIRECTORY, 'probe-tested.json');

type EndpointHint = 'chat' | 'responses' | 'interactions';
type CapabilitySkipMap = Partial<Record<ModelCapability, string>>;

const COMPLETIONS_ONLY_PATTERNS = [
  'v1/completions',
  'not a chat model',
  'completions endpoint',
  'not supported in the v1/chat/completions',
  'v1/chat/completions endpoint',
  'did you mean to use v1/completions'
];

const QUOTA_PATTERNS = [
  'insufficient_quota',
  'resource_exhausted',
  'quota exceeded',
  'requires more credits',
  'can only afford',
  'add more credits',
  'status 402'
];

const ACCESS_PATTERNS = [
  'not allowed to sample',
  'does not have access',
  'do not have access',
  "don't have access",
  'you do not have access',
  'no access to model',
  'organization must be verified',
  'verify organization',
  'user not found',
  'unauthorized',
  'invalid api key',
  'api key is invalid',
  'permission denied',
  'non-serverless model',
  'dedicated endpoint'
];

const DATA_POLICY_PATTERNS = [
  'no endpoints found matching your data policy'
];

const MODEL_NOT_FOUND_PATTERNS = [
  'model not found',
  'model_not_found',
  'not found for api version',
  'not supported for generatecontent',
  'does not support \'generatecontent\'',
  'does not support "generatecontent"',
  'does not support generatecontent'
];

const CAPACITY_PATTERNS = [
  'no available capacity'
];

const TRANSIENT_PATTERNS = [
  'server_error',
  'the server had an error',
  'temporarily unavailable',
  'timeout',
  'timed out',
  'econnreset',
  'etimedout',
  'eai_again',
  'enotfound',
  'socket hang up',
  'status code 429',
  'status 429',
  'rate limit',
  'rate-limited upstream',
  'temporarily rate-limited'
];

const TOOLS_REQUIRED_PATTERNS = [
  'require at least one of',
  'web_search_preview',
  'file_search',
  'mcp',
  'computer use tool',
  'computer-use'
];

const TOOL_UNSUPPORTED_PATTERNS = [
  "unsupported parameter: 'tools'",
  'unsupported parameter: "tools"',
  "unsupported parameter: 'tool_choice'",
  'unsupported parameter: "tool_choice"',
  "unknown parameter: 'tools'",
  'unknown parameter: "tools"',
  "unknown parameter: 'tool_choice'",
  'unknown parameter: "tool_choice"',
  'tool calls are not supported',
  'tool call is not supported',
  'tool calling is not supported',
  'tool_calls is not supported',
  'tool_choice is not supported',
  'tools are not supported',
  'tools is not supported',
  'tools not supported',
  'does not support tools',
  'does not support tool',
  'function calling is not supported',
  'function_call is not supported',
];

const SPECIAL_PROMPT_PATTERNS = [
  'expected `<code>',
  'expected <code>',
  '<update>',
  'requires special prompt format'
];

const UNSUPPORTED_MODALITIES_PATTERNS = [
  'does not support audio modality',
  'does not support image modality',
  'unknown parameter: \'modalities\'',
  'unknown parameter: "modalities"'
];

const STREAM_UNSUPPORTED_PATTERNS = [
  'stream call failed: request failed with status code 400',
  'stream call failed: request failed with status code 404',
  'empty stream',
  "does not support 'streamgeneratecontent'",
  'does not support "streamgeneratecontent"',
  'does not support streamgeneratecontent',
  'response modalities',
  'requested combination of response modalities'
];

const IMAGE_INPUT_SWAP_PATTERNS = [
  'image data you provided does not represent a valid image',
  'failed to decode image buffer',
  'invalid image url',
  'provided image is not valid',
  'unsupported image',
  'invalid image data',
  'could not process image',
  'image dimensions are too small',
  'unable to process input image'
];

const DATA_URL_REQUIRED_PATTERNS = [
  'expected a base64-encoded data url',
  "without the 'data:' prefix"
];

const ALL_CAPABILITIES: ModelCapability[] = ['text', 'image_input', 'image_output', 'audio_input', 'audio_output', 'tool_calling'];

function detectEndpointHint(outcomeLower: string): EndpointHint | null {
  if (outcomeLower.includes('interactions api')) return 'interactions';
  if (outcomeLower.includes('only supported in v1/responses')) return 'responses';
  if (outcomeLower.includes('not supported in v1/responses')) return 'chat';
  if (outcomeLower.includes('not supported with the responses api')) return 'chat';
  if (outcomeLower.includes('only supported in v1/chat/completions')) return 'chat';
  if (outcomeLower.includes("missing required parameter: 'messages'")) return 'responses';
  if (outcomeLower.includes("missing required parameter: 'input'")) return 'chat';
  if (outcomeLower.includes('not supported in v1/chat/completions') && outcomeLower.includes('responses')) return 'responses';
  return null;
}

function isCompletionsOnlyError(outcomeLower: string): boolean {
  return COMPLETIONS_ONLY_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isQuotaError(outcomeLower: string): boolean {
  return QUOTA_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isQuotaSkipValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.toLowerCase().includes('quota exceeded');
}

function isOkResult(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('ok');
}

function inferCapabilitiesFromStoredResults(entry?: Record<string, string>): ModelCapability[] {
  if (!entry) return [];
  const caps = new Set<ModelCapability>();
  if (isOkResult(entry.text)) caps.add('text');
  if (isOkResult(entry.image_input)) caps.add('image_input');
  if (isOkResult(entry.image_output)) caps.add('image_output');
  if (isOkResult(entry.audio_input)) caps.add('audio_input');
  if (isOkResult(entry.audio_output)) caps.add('audio_output');
  if (isOkResult(entry.tool_calling)) caps.add('tool_calling');
  return ALL_CAPABILITIES.filter((cap) => caps.has(cap));
}

function isRetryableSkipValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return (
    lower.includes('rate limit')
    || lower.includes('rate-limited')
    || lower.includes('rate limited')
    || lower.includes('status 429')
    || lower.includes('timeout')
    || lower.includes('quota exceeded')
    || lower.includes('no available capacity')
    || lower.includes('no access')
    || lower.includes('organization verification required')
    || lower.includes('image generation unavailable')
    || lower.includes('image input rate limit')
    || lower.includes('input-images rate limit')
    || lower.includes('audio endpoint requires openai provider')
  );
}

function isImageGenerationUnavailableSkipValue(value: unknown, testName?: string): boolean {
  if (testName !== 'image_output') return false;
  if (typeof value !== 'string') return false;
  return value.toLowerCase().includes('image generation unavailable');
}

function isRetryableSkipReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return (
    lower.includes('rate limit')
    || lower.includes('rate-limited')
    || lower.includes('timeout')
    || lower.includes('quota exceeded')
    || lower.includes('no available capacity')
    || lower.includes('no access')
    || lower.includes('organization verification required')
    || lower.includes('image generation unavailable')
    || lower.includes('image input rate limit')
    || lower.includes('input-images rate limit')
    || lower.includes('audio endpoint requires openai provider')
  );
}

function isAccessError(outcomeLower: string): boolean {
  return ACCESS_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isDataPolicyError(outcomeLower: string): boolean {
  return DATA_POLICY_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isModelNotFoundError(outcomeLower: string): boolean {
  return MODEL_NOT_FOUND_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isCapacityError(outcomeLower: string): boolean {
  return CAPACITY_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isTransientError(outcomeLower: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isRateLimitError(outcomeLower: string): boolean {
  return (
    outcomeLower.includes('rate limit')
    || outcomeLower.includes('rate_limit')
    || outcomeLower.includes('status code 429')
    || outcomeLower.includes('status 429')
    || outcomeLower.includes('too many requests')
    || outcomeLower.includes('rate-limited upstream')
    || outcomeLower.includes('temporarily rate-limited')
  );
}

function isTimeoutError(outcomeLower: string): boolean {
  return (
    outcomeLower.includes('timeout after')
    || outcomeLower.includes('timed out')
    || outcomeLower.includes('etimedout')
  );
}

function isServerError(outcomeLower: string): boolean {
  return (
    outcomeLower.includes('server_error')
    || outcomeLower.includes('internal server error')
    || outcomeLower.includes('status code 500')
    || outcomeLower.includes('status 500')
    || outcomeLower.includes('status code 502')
    || outcomeLower.includes('status 502')
    || outcomeLower.includes('status code 503')
    || outcomeLower.includes('status 503')
    || outcomeLower.includes('status code 504')
    || outcomeLower.includes('status 504')
    || outcomeLower.includes('bad gateway')
    || outcomeLower.includes('service unavailable')
    || outcomeLower.includes('gateway timeout')
  );
}

function isImageInputLimitZero(outcomeLower: string): boolean {
  return (
    (outcomeLower.includes('input-images') || outcomeLower.includes('input images'))
    && outcomeLower.includes('per min')
    && outcomeLower.includes('limit 0')
  );
}

function isStreamingUnsupportedError(
  outcomeLower: string,
  testName?: string,
  mode?: 'stream' | 'normal'
): boolean {
  if (mode !== 'stream' && testName !== 'streaming' && testName !== 'realtime') return false;
  return STREAM_UNSUPPORTED_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function shouldSwapImageUrl(outcomeLower: string, currentUrl: string): boolean {
  const isDataUrl = currentUrl.startsWith('data:');
  if (!isDataUrl && DATA_URL_REQUIRED_PATTERNS.some((pattern) => outcomeLower.includes(pattern))) return true;
  if (IMAGE_INPUT_SWAP_PATTERNS.some((pattern) => outcomeLower.includes(pattern))) return true;
  return false;
}

function isImageGenerationUnavailable(outcomeLower: string, testName?: string): boolean {
  const hasRegion =
    outcomeLower.includes('region')
    || outcomeLower.includes('country')
    || outcomeLower.includes('location')
    || outcomeLower.includes('provider region')
    || outcomeLower.includes('supported region')
    || outcomeLower.includes('supported regions')
    || outcomeLower.includes('supported location')
    || outcomeLower.includes('supported locations')
    || outcomeLower.includes('project region')
    || outcomeLower.includes('project location');
  if (!hasRegion) return false;

  const hasUnavailable =
    outcomeLower.includes('not available')
    || outcomeLower.includes('unavailable')
    || outcomeLower.includes('not supported')
    || outcomeLower.includes('unsupported')
    || outcomeLower.includes('not enabled')
    || outcomeLower.includes('disabled');
  if (!hasUnavailable) return false;

  if (
    outcomeLower.includes('image generation')
    || outcomeLower.includes('image output')
    || outcomeLower.includes('imagen')
    || outcomeLower.includes('response modalities')
  ) {
    return true;
  }

  return testName === 'image_output';
}

function isToolsRequiredError(outcomeLower: string): boolean {
  return TOOLS_REQUIRED_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isToolUnsupportedError(outcomeLower: string): boolean {
  if (TOOL_UNSUPPORTED_PATTERNS.some((pattern) => outcomeLower.includes(pattern))) return true;
  return outcomeLower.includes('tools') && outcomeLower.includes('not supported');
}

function isSpecialPromptError(outcomeLower: string): boolean {
  return SPECIAL_PROMPT_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function isModalitiesUnsupportedError(outcomeLower: string): boolean {
  return UNSUPPORTED_MODALITIES_PATTERNS.some((pattern) => outcomeLower.includes(pattern));
}

function shouldSkipLegacyCompletionsModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Embedding models are handled separately — exclude them here
  if (isEmbeddingModel(id)) return false;
  return (
    id.startsWith('davinci') ||
    id.startsWith('text-davinci') ||
    id.startsWith('curie') ||
    id.startsWith('text-curie') ||
    id.startsWith('babbage') ||
    id.startsWith('text-babbage') ||
    id.startsWith('ada') ||
    id.startsWith('text-ada') ||
    id.includes('gpt-3.5-turbo-instruct') ||
    isFineTunedModel(id)
  );
}

/**
 * Detect realtime models (WebSocket-based, can't be probed via HTTP).
 * These models support text + audio I/O via the Realtime API.
 */
function isRealtimeModel(modelId: string): boolean {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  return id.includes('realtime');
}

/**
 * Returns known capabilities for models that can't be probed via standard HTTP,
 * based on their model ID patterns. Returns null if not a known model type.
 */
function getKnownCapabilities(modelId: string): { caps: ModelCapability[]; reason: string } | null {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  if (!id) return null;

  // Image generation models (Imagen, DALL-E, GPT-Image, Grok Imagine)
  if (id.startsWith('imagen-') || id.startsWith('dall-e') || id.startsWith('gpt-image') || id.includes('gpt-5-image') || id === 'chatgpt-image-latest') {
    return { caps: ['text', 'image_output'], reason: 'image generation model' };
  }
  if (id.includes('nano-banana')) {
    return { caps: ['text', 'image_input', 'image_output'], reason: 'nano banana multimodal image model' };
  }
  if (id.includes('grok-imagine-image') || id.includes('grok-2-image')) {
    return { caps: ['text', 'image_output'], reason: 'xAI image generation model' };
  }

  // Video generation models (Sora, Veo, Grok Imagine Video)
  if (id.startsWith('sora') || id.startsWith('veo-')) {
    return { caps: ['text', 'image_output'], reason: 'video generation model' };
  }
  if (id.includes('grok-imagine-video')) {
    return { caps: ['text', 'image_output'], reason: 'xAI video generation model' };
  }

  // Deep research / tool-use models
  if (id.includes('deep-research')) {
    return { caps: ['text', 'tool_calling'], reason: 'deep research model' };
  }

  // OpenAI o3/o4 and Responses-centric tool-use models
  if (id.startsWith('o3') || id.startsWith('o4')) {
    return { caps: ['text', 'tool_calling'], reason: 'responses tool-use model' };
  }

  // Function-calling / tool-use models
  if (id.includes('function') || id.includes('tool')) {
    return { caps: ['text', 'tool_calling'], reason: 'tool-use model' };
  }

  // Gemini 3.1 Pro preview variants support function/tool calling, but shared
  // probes can miss it because unrelated image/quota failures may short-circuit
  // the run before the tool probe completes.
  if (id.includes('gemini-3.1-pro-preview')) {
    return { caps: ['text', 'image_input', 'audio_input', 'tool_calling'], reason: 'known Gemini 3.1 Pro preview tool-use model' };
  }

  // Native audio models (Gemini)
  if (id.includes('native-audio')) {
    return { caps: ['text', 'audio_input', 'audio_output'], reason: 'native audio model' };
  }

  // Computer use models
  if (id.includes('computer-use')) {
    return { caps: ['text', 'image_input', 'tool_calling'], reason: 'computer use model' };
  }

  // Embedding models
  if (id.includes('embedding')) {
    return { caps: ['text'], reason: 'embedding model' };
  }

  // AQA (Google Attributed Question Answering)
  if (id === 'aqa') {
    return { caps: ['text'], reason: 'AQA model' };
  }

  // xAI image/video models
  if (id.includes('grok') && (id.includes('image') || id.includes('imagine') || id.includes('video'))) {
    if (id.includes('video')) return { caps: ['text', 'image_output'], reason: 'xAI video model' };
    return { caps: ['text', 'image_output'], reason: 'xAI image model' };
  }

  // Sora video models
  if (id.startsWith('sora')) {
    return { caps: ['text', 'image_output'], reason: 'Sora video model' };
  }

  // TTS models
  if (id.startsWith('tts-') || id.includes('-tts')) {
    return { caps: ['text', 'audio_output'], reason: 'TTS model' };
  }

  // Whisper/STT models
  if (id.startsWith('whisper') || id.includes('transcribe')) {
    return { caps: ['audio_input', 'text'], reason: 'STT model' };
  }

  // Moderation models
  if (id.includes('moderation')) {
    return { caps: ['text'], reason: 'moderation model' };
  }

  // Responses-only / tool-requiring models

  return null;
}

/**
 * Detect embedding-only models that need the /v1/embeddings endpoint.
 */
function isEmbeddingModel(modelId: string): boolean {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  return id.startsWith('text-embedding') || id.includes('embedding');
}

/**
 * Detect fine-tuned models (ft: prefix or :ft- infix).
 * These are typically tied to specific OpenAI accounts/orgs and
 * will 404 for keys that don't own them.
 */
function isFineTunedModel(modelId: string): boolean {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  return id.startsWith('ft:') || id.includes(':ft-') || id.includes(':ft:');
}

/**
 * Detect private fine-tuned models that are tied to a specific org/account.
 * All fine-tuned models are org-specific — they will 404 for keys that
 * don't own them. The probe can't test them since it uses shared keys.
 */
function isPrivateFineTune(modelId: string): boolean {
  return isFineTunedModel(modelId);
}

function isXaiMediaModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('image') || id.includes('video') || id.includes('imagine');
}

function isRelaceModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('relace/');
}

function isModerationModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('moderation');
}

function classifyAudioOnlyModel(modelId: string): 'tts' | 'stt' | null {
  const id = modelId.toLowerCase();
  if (
    id.startsWith('tts-')
    || id.includes('-tts')
    || id.includes('text-to-speech')
    || id.includes('preview-tts')
    || id.includes('native-audio')
  ) return 'tts';
  if (id.startsWith('whisper') || id.includes('transcribe') || id.includes('speech-to-text')) return 'stt';
  return null;
}

function isImageGenerationModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!id) return false;
  return (
    id.includes('dall-e')
    || id.includes('gpt-image')
    || id.includes('imagen')
    || id.includes('veo')
    || id.includes('sora')
    || id.includes('nano-banana')
    || (id.includes('image') && !id.includes('image_input'))
  );
}

function shouldTreatCompletionsErrorAsResponses(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    id.includes('computer-use')
    || id.startsWith('o3')
    || id.startsWith('o4')
    || id.includes('deep-research')
  );
}

function appendProbeLog(entry: Record<string, any>) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    fs.mkdirSync(path.dirname(PROBE_LOG_PATH), { recursive: true });
    fs.appendFileSync(PROBE_LOG_PATH, `${line}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to write probe log:', err);
  }
}

type ProbeLogEntry = {
  timestamp?: string;
  type?: string;
  modelId?: string;
  providerId?: string;
  test?: string;
  outcome?: string;
  reason?: string;
};

type ProbeTestedFile = {
  updated_at: string;
  data: Record<string, Record<string, string>>;
  capability_skips?: Record<string, Record<string, string>>;
};

type ProbeLogHints = {
  modelEndpointHints: Map<string, EndpointHint>;
  modelSkipReasons: Map<string, string>;
  testSkipReasons: Map<string, Map<string, string>>;
  testFailReasons: Map<string, Set<string>>;
};

type OutcomeClassification = {
  endpointHint?: EndpointHint;
  skipReason?: string;
  skipScope?: 'model' | 'test';
  retryable?: boolean;
};

function parseList(raw: string): string[] {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProbeTested(): ProbeTestedFile {
  if (!fs.existsSync(PROBE_TESTED_PATH)) {
    return { updated_at: new Date().toISOString(), data: {} };
  }
  try {
    const raw = fs.readFileSync(PROBE_TESTED_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ProbeTestedFile;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid probe-tested.json');
    if (!parsed.data || typeof parsed.data !== 'object') parsed.data = {};
    if (!parsed.capability_skips || typeof parsed.capability_skips !== 'object') parsed.capability_skips = {};
    if (!parsed.updated_at || typeof parsed.updated_at !== 'string') {
      parsed.updated_at = new Date().toISOString();
    }
    return parsed;
  } catch (err) {
    console.warn('Failed to read probe-tested.json, starting fresh:', err);
    return { updated_at: new Date().toISOString(), data: {} };
  }
}

function saveProbeTested(file: ProbeTestedFile) {
  try {
    fs.mkdirSync(path.dirname(PROBE_TESTED_PATH), { recursive: true });
    fs.writeFileSync(PROBE_TESTED_PATH, JSON.stringify(file, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write probe-tested.json:', err);
  }
}

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next && this.available > 0) {
      this.available -= 1;
      next();
    }
  }
}

function normalizeSkipReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('completions')) return 'completions-only model';
  if (lower.includes('quota')) return 'quota exceeded';
  if (lower.includes('interaction')) return 'interactions-only model';
  if (lower.includes('legacy completions')) return 'legacy completions model';
  if (lower.includes('no available capacity')) return 'no available capacity';
  if (
    lower.includes('not allowed')
    || lower.includes('does not have access')
    || lower.includes('do not have access')
    || lower.includes("don't have access")
    || lower.includes('no access')
  ) return 'no access';
  if (lower.includes('data policy')) return 'data policy restriction';
  if (lower.includes('model not found')) return 'model not found';
  if (lower.includes('special prompt format')) return 'requires special prompt format';
  return reason;
}

function shouldPersistCapabilitySkip(skipReason: string, testName: string): boolean {
  const cap = testName as ModelCapability;
  if (!ALL_CAPABILITIES.includes(cap)) return false;
  const lower = skipReason.toLowerCase();
  if (!lower.startsWith('unsupported')) return false;
  if (lower.includes('rate limit') || lower.includes('rate-limited') || lower.includes('timeout')) return false;
  return true;
}

function normalizeCapabilitySkips(raw: unknown): Map<ModelCapability, string> {
  const map = new Map<ModelCapability, string>();
  if (!raw || typeof raw !== 'object') return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALL_CAPABILITIES.includes(key as ModelCapability)) continue;
    if (typeof value === 'string' && value.trim()) {
      map.set(key as ModelCapability, value.trim());
    }
  }
  return map;
}

function persistCapabilitySkip(
  store: Record<string, Record<string, string>>,
  modelId: string,
  map: Map<ModelCapability, string>,
  cap: ModelCapability,
  reason: string
) {
  if (!reason || map.has(cap)) return;
  map.set(cap, reason);
  if (!store[modelId]) store[modelId] = {};
  store[modelId][cap] = reason;
}

function extractSupportedValues(outcomeLower: string): string[] {
  const values: string[] = [];
  const supportedIndex = outcomeLower.indexOf('supported values are');
  const allowedIndex = outcomeLower.indexOf('allowed values are');
  const startIndex = supportedIndex >= 0
    ? supportedIndex
    : (allowedIndex >= 0 ? allowedIndex : -1);

  const extractFrom = (text: string) => {
    const regex = /'([^']+)'|"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      const value = match[1] || match[2];
      if (value) values.push(value);
    }
  };

  if (startIndex >= 0) {
    extractFrom(outcomeLower.slice(startIndex));
  } else {
    extractFrom(outcomeLower);
  }

  return values;
}

function classifyUnsupportedCapability(outcomeLower: string, testName?: string): string | null {
  if (!testName) return null;

  if (outcomeLower.includes('no endpoints found that support image input')) {
    if (testName === 'image_input') return 'unsupported image input';
  }
  if (outcomeLower.includes('no endpoints found that support input audio')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }
  if (outcomeLower.includes('no endpoints found that support the requested output modalities')) {
    if (testName === 'image_output' && outcomeLower.includes('image')) return 'unsupported image output';
    if (testName === 'audio_output' && outcomeLower.includes('audio')) return 'unsupported audio output';
  }
  if (outcomeLower.includes('does not support the requested response modalities')) {
    if (testName === 'image_output' && outcomeLower.includes('image')) return 'unsupported image output';
    if (testName === 'audio_output' && outcomeLower.includes('audio')) return 'unsupported audio output';
  }

  if (isModalitiesUnsupportedError(outcomeLower)) {
    if (testName === 'image_output') return 'unsupported image output';
    if (testName === 'audio_output') return 'unsupported audio output';
  }

  if (outcomeLower.includes('does not support audio modality')) {
    if (testName === 'audio_output') return 'unsupported audio output';
  }

  if (outcomeLower.includes('does not support image modality')) {
    if (testName === 'image_output') return 'unsupported image output';
  }

  if (outcomeLower.includes('content blocks are expected to be either text or image_url type')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }

  if (outcomeLower.includes('image_url is only supported by certain models')) {
    if (testName === 'image_input') return 'unsupported image input';
  }

  if (outcomeLower.includes('image input modality is not enabled')) {
    if (testName === 'image_input') return 'unsupported image input';
  }
  if (outcomeLower.includes('audio input modality is not enabled')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }

  if (outcomeLower.includes('image inputs are not supported by this model')) {
    if (testName === 'image_input') return 'unsupported image input';
  }

  if (outcomeLower.includes('failed to decode image buffer')) {
    if (testName === 'image_input') return 'unsupported image input';
  }

  if (outcomeLower.includes('does not support image_url content')) {
    if (testName === 'image_input') return 'unsupported image input';
  }

  if (outcomeLower.includes('unknown variant `image_url`')) {
    if (testName === 'image_input') return 'unsupported image input';
  }

  if (outcomeLower.includes('unknown variant `input_audio`')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }

  if (outcomeLower.includes('invalid value') && outcomeLower.includes('input_audio')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }

  if (outcomeLower.includes("does not support 'streamgeneratecontent'")) {
    if (testName === 'audio_output') return 'unsupported audio output';
  }

  if (outcomeLower.includes('response_mime_type') && outcomeLower.includes('allowed mimetypes')) {
    if (testName === 'audio_output') return 'unsupported audio output';
  }

  if (
    outcomeLower.includes('openrouter api stream call failed')
    && (
      outcomeLower.includes('status code 400')
      || outcomeLower.includes('status code 404')
      || outcomeLower.includes('status 404')
    )
  ) {
    if (testName === 'audio_output') return 'unsupported audio output';
  }

  if (outcomeLower.includes('invalid response structure received from gemini api')) {
    if (testName === 'audio_input') return 'unsupported audio input';
  }

  const supportedValues = extractSupportedValues(outcomeLower);
  if (supportedValues.length > 0) {
    const includes = (needle: string) => supportedValues.some((value) => value.includes(needle));

    if (testName === 'image_output' && !includes('image')) return 'unsupported image output';
    if (testName === 'audio_output' && !includes('audio')) return 'unsupported audio output';
    if (testName === 'audio_input' && !includes('input_audio') && !includes('audio')) return 'unsupported audio input';
    if (testName === 'image_input' && !includes('image_url') && !includes('input_image') && !includes('image')) return 'unsupported image input';
  }

  return null;
}

function classifyOutcome(outcomeLower: string, testName?: string): OutcomeClassification {
  const endpointHint = detectEndpointHint(outcomeLower);

  if (endpointHint === 'interactions') {
    return { endpointHint, skipReason: 'interactions-only model', skipScope: 'model' };
  }

  if (isCompletionsOnlyError(outcomeLower)) return { skipReason: 'completions-only model', skipScope: 'model' };
  if (isQuotaError(outcomeLower)) return { skipReason: 'quota exceeded', skipScope: 'model' };
  if (isCapacityError(outcomeLower)) return { skipReason: 'no available capacity', skipScope: 'model' };
  if (isAccessError(outcomeLower)) return { skipReason: 'no access', skipScope: 'model' };
  if (isDataPolicyError(outcomeLower)) return { skipReason: 'data policy restriction', skipScope: 'model' };
  if (isModelNotFoundError(outcomeLower)) return { skipReason: 'model not found', skipScope: 'model' };
  if (isToolsRequiredError(outcomeLower)) return { skipReason: 'requires tools', skipScope: 'model' };
  if (isSpecialPromptError(outcomeLower)) return { skipReason: 'requires special prompt format', skipScope: 'model' };

  const unsupported = classifyUnsupportedCapability(outcomeLower, testName);
  if (unsupported) return { skipReason: unsupported, skipScope: 'test' };

  if (isStreamingUnsupportedError(outcomeLower, testName)) return { skipReason: 'streaming unsupported', skipScope: 'test' };

  if (isTransientError(outcomeLower)) return { retryable: true };

  return endpointHint ? { endpointHint } : {};
}

function loadProbeLogHints(): ProbeLogHints {
  const hints: ProbeLogHints = {
    modelEndpointHints: new Map(),
    modelSkipReasons: new Map(),
    testSkipReasons: new Map(),
    testFailReasons: new Map(),
  };

  if (!fs.existsSync(PROBE_LOG_PATH)) return hints;

  let raw = '';
  try {
    raw = fs.readFileSync(PROBE_LOG_PATH, 'utf8');
  } catch (err) {
    console.warn('Failed to read probe log:', err);
    return hints;
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const start = MAX_PROBE_LOG_LINES > 0 ? Math.max(0, lines.length - MAX_PROBE_LOG_LINES) : 0;

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    let entry: ProbeLogEntry | null = null;
    try {
      entry = JSON.parse(line) as ProbeLogEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const modelId = typeof entry.modelId === 'string' ? entry.modelId : '';
    if (!modelId) continue;

    const outcomeText = typeof entry.outcome === 'string'
      ? entry.outcome
      : (typeof entry.reason === 'string' ? entry.reason : '');
    const outcomeLower = outcomeText.toLowerCase();
    const test = typeof entry.test === 'string' ? entry.test : '';
    const classification = outcomeLower ? classifyOutcome(outcomeLower, test) : {};

    if (classification.endpointHint) {
      hints.modelEndpointHints.set(modelId, classification.endpointHint);
    }

    let skipReason = classification.skipReason || '';
    const skipScope = classification.skipScope;
    if (!skipReason && typeof entry.reason === 'string' && entry.reason.trim()) {
      skipReason = normalizeSkipReason(entry.reason.trim());
    }

    if (skipReason) {
      const skipLower = skipReason.toLowerCase();
      if (
        skipLower.includes('quota exceeded')
        || skipLower.includes('rate limited')
        || skipLower.includes('timeout')
        || skipLower.includes('server error')
        || skipLower.includes('no access')
        || skipLower.includes('image generation unavailable')
        || skipLower.includes('audio endpoint requires openai provider')
      ) {
        continue;
      }
      if (skipLower.includes('completions-only model') && shouldTreatCompletionsErrorAsResponses(modelId)) {
        continue;
      }
      if (skipScope === 'model') {
        hints.modelSkipReasons.set(modelId, skipReason);
      } else if (test) {
        let perTest = hints.testSkipReasons.get(modelId);
        if (!perTest) {
          perTest = new Map();
          hints.testSkipReasons.set(modelId, perTest);
        }
        perTest.set(test, skipReason);
      } else {
        hints.modelSkipReasons.set(modelId, skipReason);
      }
    }

    if (entry.type === 'probe_fail' && test && ALL_CAPABILITIES.includes(test as ModelCapability)) {
      let perTest = hints.testFailReasons.get(modelId);
      if (!perTest) {
        perTest = new Set();
        hints.testFailReasons.set(modelId, perTest);
      }
      perTest.add(test);
    }
  }

  return hints;
}

function loadQuotaDisabledProviders(): Set<string> {
  const currentState = new Map<string, boolean>();
  if (!fs.existsSync(PROBE_LOG_PATH)) return new Set<string>();

  let raw = '';
  try {
    raw = fs.readFileSync(PROBE_LOG_PATH, 'utf8');
  } catch (err) {
    console.warn('Failed to read probe log for quota-disabled providers:', err);
    return new Set<string>();
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const start = MAX_PROBE_LOG_LINES > 0 ? Math.max(0, lines.length - MAX_PROBE_LOG_LINES) : 0;

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    let entry: ProbeLogEntry | null = null;
    try {
      entry = JSON.parse(line) as ProbeLogEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const providerId = typeof entry.providerId === 'string' ? entry.providerId : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.toLowerCase() : '';
    if (!providerId || !reason) continue;
    if (entry.type === 'provider_reenabled') {
      currentState.set(providerId, false);
      continue;
    }
    if (
      (entry.type === 'provider_disabled' || entry.type === 'provider_no_quota' || entry.type === 'key_no_quota')
      && reason.includes('quota')
    ) {
      currentState.set(providerId, true);
    }
  }

  return new Set<string>(
    Array.from(currentState.entries())
      .filter(([_, disabled]) => disabled)
      .map(([providerId]) => providerId)
  );
}

const SAMPLE_IMAGE_URLS = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OoQEAAAwCIE/f5+4MC4FOcu2UgICAgICAgICAgICAgIDAOvBNk/iIqacviQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QQREAAAiAMPuX1hh7yBJwzD43OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0ARtDDsqXe37wAAAAASUVORK5CYII=',
  'https://placehold.co/64x64/png'
];
const openrouterSemaphore = new Semaphore(OPENROUTER_CONCURRENCY);
const providerSemaphores = new Map<string, Semaphore>();
const rateLimitUntil = new Map<string, number>();
const rateLimitBackoff = new Map<string, number>();
const serverErrorUntil = new Map<string, number>();
const serverErrorBackoff = new Map<string, number>();
const providerCooldownUntil = new Map<string, number>();
let openrouterGlobalRateLimitUntil = 0;
const providerTierRank = new Map<string, number>();
const providerOrderIndex = new Map<string, number>();
// 0.25 second of silence WAV (8k mono 16-bit)
const SAMPLE_AUDIO_BASE64 =
  'UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function resolveProviderUrl(p: LoadedProviderData, endpointHint?: EndpointHint): string {
  let url = p.provider_url || '';

  if (!p.id.includes('openai')) return url;

  if (endpointHint === 'responses') {
    if (url.includes('/chat/completions')) return url.replace('/chat/completions', '/responses');
    if (!url) return 'https://api.openai.com/v1/responses';
  }

  if (endpointHint === 'chat') {
    if (url.includes('/responses')) return url.replace('/responses', '/chat/completions');
    if (!url) return 'https://api.openai.com/v1/chat/completions';
  }

  return url;
}

function extractOrigin(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return '';
  }
}

function resolveAudioUrl(p: LoadedProviderData, endpoint: 'speech' | 'transcriptions'): string {
  const url = p.provider_url || '';
  if (!url) return `https://api.openai.com/v1/audio/${endpoint}`;

  if (url.includes('/v1/')) {
    const idx = url.indexOf('/v1/');
    return `${url.slice(0, idx + 4)}audio/${endpoint}`;
  }

  if (url.endsWith('/v1')) return `${url}/audio/${endpoint}`;

  const origin = extractOrigin(url);
  if (origin) return `${origin}/v1/audio/${endpoint}`;

  return `${url.replace(/\/+$/, '')}/v1/audio/${endpoint}`;
}

function resolveModerationsUrl(p: LoadedProviderData): string {
  const url = p.provider_url || '';
  if (!url) return 'https://api.openai.com/v1/moderations';

  if (url.includes('/v1/')) {
    const idx = url.indexOf('/v1/');
    return `${url.slice(0, idx + 4)}moderations`;
  }

  if (url.endsWith('/v1')) return `${url}/moderations`;

  const origin = extractOrigin(url);
  if (origin) return `${origin}/v1/moderations`;

  return `${url.replace(/\/+$/, '')}/v1/moderations`;
}

function resolveCompletionsUrl(p: LoadedProviderData): string {
  let url = p.provider_url || '';
  if (!url) return 'https://api.openai.com/v1/completions';
  if (url.includes('/chat/completions')) return url.replace('/chat/completions', '/completions');
  if (url.includes('/responses')) return url.replace('/responses', '/completions');
  if (url.endsWith('/v1')) return `${url}/completions`;
  if (url.includes('/v1/')) {
    const idx = url.indexOf('/v1/');
    return `${url.slice(0, idx + 4)}completions`;
  }
  return url;
}

function resolveProviderFamily(providerId: string): string {
  if (providerId.includes('openai')) return 'openai';
  if (providerId.includes('anthropic')) return 'anthropic';
  if (providerId.includes('openrouter')) return 'openrouter';
  if (providerId.includes('deepseek')) return 'deepseek';
  if (providerId.includes('imagen')) return 'gemini';
  if (providerId.includes('gemini') || providerId === 'google') return 'gemini';
  if (providerId.includes('xai')) return 'xai';
  return providerId;
}

function providerMatchesFilters(providerId: string): boolean {
  if (PROVIDER_FILTERS.length === 0 && PROVIDER_FAMILIES.length === 0) return true;
  const id = providerId.toLowerCase();
  const family = resolveProviderFamily(id);
  if (PROVIDER_FAMILIES.length > 0 && PROVIDER_FAMILIES.includes(family)) return true;
  if (PROVIDER_FILTERS.length > 0 && PROVIDER_FILTERS.some((token) => id.includes(token))) return true;
  return false;
}

function modelMatchesFilters(modelId: string): boolean {
  if (MODEL_FILTERS.length === 0) return true;
  const id = modelId.toLowerCase();
  return MODEL_FILTERS.some((token) => id.includes(token));
}

function buildSyntheticProvider(modelIds: string[]): LoadedProviderData | null {
  if (!EXPLICIT_API_KEY) return null;
  const uniqueModelIds = Array.from(new Set(modelIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (uniqueModelIds.length === 0) return null;

  const models = Object.fromEntries(
    uniqueModelIds.map((modelId) => [modelId, {
      id: modelId,
      token_generation_speed: 50,
      response_times: [],
      errors: 0,
      consecutive_errors: 0,
      avg_response_time: null,
      avg_provider_latency: null,
      avg_token_speed: null,
      rate_limit_rps: null,
      disabled: false,
    }])
  );

  return {
    id: EXPLICIT_PROVIDER_ID,
    apiKey: EXPLICIT_API_KEY,
    provider_url: EXPLICIT_PROVIDER_URL,
    streamingCompatible: true,
    models,
    disabled: false,
    avg_response_time: null,
    avg_provider_latency: null,
    errors: 0,
    provider_score: null,
  };
}

function getProviderSemaphore(providerId: string): Semaphore {
  let semaphore = providerSemaphores.get(providerId);
  if (!semaphore) {
    semaphore = new Semaphore(PROVIDER_CONCURRENCY);
    providerSemaphores.set(providerId, semaphore);
  }
  return semaphore;
}

function getProviderTierRank(providerId: string): number {
  if (providerTierRank.has(providerId)) {
    return providerTierRank.get(providerId)!;
  }
  const match = providerId.match(/-t(\d+|\?)-/i);
  let rank = -1;
  if (match && match[1] && match[1] !== '?') {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) rank = parsed;
  }
  providerTierRank.set(providerId, rank);
  return rank;
}

function markRateLimited(providerId: string) {
  const now = Date.now();
  const prev = rateLimitBackoff.get(providerId) || 0;
  const next = Math.min(prev + 1, RATE_LIMIT_BACKOFF_MAX);
  rateLimitBackoff.set(providerId, next);
  const base = RATE_LIMIT_WAIT_MS;
  const wait = base * Math.pow(2, Math.max(0, next - 1));
  const jitter = RATE_LIMIT_JITTER_MS > 0 ? Math.floor(Math.random() * RATE_LIMIT_JITTER_MS) : 0;
  const until = now + wait + jitter;
  rateLimitUntil.set(providerId, until);
  if (providerId.includes('openrouter')) {
    openrouterGlobalRateLimitUntil = Math.max(openrouterGlobalRateLimitUntil, until);
  }
}

function markServerError(providerId: string) {
  const now = Date.now();
  const prev = serverErrorBackoff.get(providerId) || 0;
  const next = Math.min(prev + 1, SERVER_ERROR_BACKOFF_MAX);
  serverErrorBackoff.set(providerId, next);
  const base = SERVER_ERROR_WAIT_MS;
  const wait = base * Math.pow(2, Math.max(0, next - 1));
  const jitter = SERVER_ERROR_JITTER_MS > 0 ? Math.floor(Math.random() * SERVER_ERROR_JITTER_MS) : 0;
  const until = now + wait + jitter;
  serverErrorUntil.set(providerId, until);
  if (providerId.includes('openrouter')) {
    openrouterGlobalRateLimitUntil = Math.max(openrouterGlobalRateLimitUntil, until);
  }
}

function getProviderReadyAt(providerId: string): number {
  const providerWaitUntil = Math.max(
    rateLimitUntil.get(providerId) || 0,
    serverErrorUntil.get(providerId) || 0,
    providerCooldownUntil.get(providerId) || 0
  );
  return providerId.includes('openrouter')
    ? Math.max(providerWaitUntil, openrouterGlobalRateLimitUntil)
    : providerWaitUntil;
}

async function withProviderLimit<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  const isOpenRouter = providerId.includes('openrouter');
  const semaphore = isOpenRouter ? openrouterSemaphore : getProviderSemaphore(providerId);
  await semaphore.acquire();
  try {
    while (true) {
      const now = Date.now();
      const providerWaitUntil = Math.max(
        rateLimitUntil.get(providerId) || 0,
        serverErrorUntil.get(providerId) || 0,
        providerCooldownUntil.get(providerId) || 0
      );
      const globalWaitUntil = isOpenRouter ? openrouterGlobalRateLimitUntil : 0;
      const waitUntil = Math.max(providerWaitUntil, globalWaitUntil);
      if (now >= waitUntil) break;
      await sleep(waitUntil - now);
    }

    return await fn();
  } finally {
    const cooldownMs = isOpenRouter ? Math.max(PROVIDER_COOLDOWN_MS, OPENROUTER_DELAY_MS) : PROVIDER_COOLDOWN_MS;
    if (cooldownMs > 0) {
      providerCooldownUntil.set(providerId, Date.now() + cooldownMs);
    }
    semaphore.release();
  }
}

// Map provider id to class resolver
function buildProviderInstance(p: LoadedProviderData, endpointHint?: EndpointHint) {
  const key = p.apiKey || '';
  const url = resolveProviderUrl(p, endpointHint);
  if (p.id.includes('openai')) return new OpenAI(key, url);
  if (p.id.includes('openrouter')) return new OpenRouterAI(key, url);
  if (p.id.includes('deepseek')) return new DeepseekAI(key, url);
  if (p.id.includes('imagen')) return new ImagenAI(key);
  if (p.id.includes('gemini') || p.id === 'google') return new GeminiAI(key);
  return new OpenAI(key, url);
}

type PickProviderOptions = {
  readyOnly?: boolean;
};

function pickProvider(
  providers: LoadedProviders,
  modelId: string,
  providerStatus?: Map<string, { ok: boolean; hasQuota: boolean }>,
  exclude?: Set<string>,
  options?: PickProviderOptions,
): LoadedProviderData | null {
  const candidates: LoadedProviderData[] = [];
  const now = Date.now();
  for (const p of providers) {
    if (exclude && exclude.has(p.id)) continue;
    if (p.disabled) continue;
    if (!p.models || !p.models[modelId]) continue;
    if (providerStatus) {
      const status = providerStatus.get(p.id);
      if (!status || !status.ok || !status.hasQuota) continue;
    }
    candidates.push(p);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const readyAtA = getProviderReadyAt(a.id);
    const readyAtB = getProviderReadyAt(b.id);
    const readyA = readyAtA <= now;
    const readyB = readyAtB <= now;
    if (readyA !== readyB) return readyA ? -1 : 1;
    if (!readyA && readyAtA !== readyAtB) return readyAtA - readyAtB;

    const tierA = getProviderTierRank(a.id);
    const tierB = getProviderTierRank(b.id);
    if (tierA !== tierB) return tierB - tierA;
    const idxA = providerOrderIndex.get(a.id) ?? 0;
    const idxB = providerOrderIndex.get(b.id) ?? 0;
    return idxA - idxB;
  });

  if (options?.readyOnly) {
    return candidates.find((candidate) => getProviderReadyAt(candidate.id) <= now) || null;
  }

  return candidates[0];
}

function getProbePrompt(testName: string, isRelace: boolean): string {
  if (isRelace) {
    return '<code>\nfunction greet() {\n  return \"hello\";\n}\n</code>\n<update>\nChange the greeting to \"goodbye\".\n</update>';
  }
  switch (testName) {
    case 'image_input':
      return 'Describe the image in one short sentence.';
    case 'image_output':
      return 'Generate a simple image of a blue square on a white background.';
    case 'audio_input':
      return 'Transcribe the provided audio.';
    case 'audio_output':
      return 'Respond with a short spoken greeting.';
    case 'streaming':
    case 'realtime':
      return 'Stream a short response.';
    case 'tool_calling':
      return 'Call the get_time tool with timezone "UTC".';
    default:
      return 'Reply with a short sentence.';
  }
}

function buildMessage(
  modelId: string,
  caps: Set<ModelCapability>,
  mode: 'stream' | 'normal',
  testName: string,
  imageUrlOverride?: string,
  options?: { audioOnlyOutput?: boolean }
): IMessage {
  const content: any[] = [];
  const imageUrl = imageUrlOverride || SAMPLE_IMAGE_URLS[0];
  const isAudioModel = modelId.toLowerCase().includes('audio');
  const isRelace = isRelaceModel(modelId);
  const audioOnlyOutput = options?.audioOnlyOutput === true;

  const prompt = getProbePrompt(testName, isRelace);

  const relaceText = isRelace ? prompt : `${prompt} [probe:${testName}]`;
  content.push({ type: 'text', text: relaceText });

  if (isRelace) {
    return { content, model: { id: modelId } };
  }

  if (caps.has('image_input')) {
    content.push({ type: 'image_url', image_url: { url: imageUrl, detail: 'low' } });
  }
  if (caps.has('audio_input')) {
    content.push({ type: 'input_audio', input_audio: { data: SAMPLE_AUDIO_BASE64, format: 'wav' } });
  }
  if (isAudioModel && (testName === 'text' || testName === 'streaming' || testName === 'realtime')) {
    const hasAudioInput = content.some((part) => part?.type === 'input_audio');
    if (!hasAudioInput) {
      content.push({ type: 'input_audio', input_audio: { data: SAMPLE_AUDIO_BASE64, format: 'wav' } });
    }
  }

  const message: IMessage = { content, model: { id: modelId } };

  if (testName === 'tool_calling') {
    message.tools = [
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Return the current time for a timezone.',
          parameters: {
            type: 'object',
            properties: {
              timezone: { type: 'string' },
            },
            required: ['timezone'],
          },
        },
      },
    ];
    message.tool_choice = { type: 'function', function: { name: 'get_time' } };
  }

  const outputModalities: string[] = [];
  if (caps.has('image_output')) outputModalities.push('image');
  if (caps.has('audio_output')) outputModalities.push('audio');
  if (outputModalities.length > 0) {
    if (audioOnlyOutput && outputModalities.length === 1 && outputModalities[0] === 'audio') {
      message.modalities = ['audio'];
    } else {
      message.modalities = ['text', ...outputModalities];
    }
  }
  if (caps.has('audio_output')) {
    message.audio = { voice: AUDIO_VOICE, format: AUDIO_FORMAT };
  }
  if (mode === 'stream') {
    message.max_output_tokens = 64;
  }

  return message;
}

async function runWithTimeout<T>(fn: () => Promise<T>, label: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
    let result: Promise<T> | T;
    try {
      result = fn();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    Promise.resolve(result)
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function formatAxiosError(err: any): string {
  const status = err?.response?.status;
  const data = err?.response?.data;
  let detail = '';

  if (data) {
    if (typeof data === 'string') {
      detail = data;
    } else if (data?.error?.message) {
      detail = data.error.message;
    } else {
      try {
        detail = JSON.stringify(data);
      } catch {
        detail = String(data);
      }
    }
  }

  const base = err?.message || 'unknown error';
  const statusPart = typeof status === 'number' ? ` (status ${status})` : '';
  const detailPart = detail ? `: ${detail}` : '';
  return `${base}${statusPart}${detailPart}`;
}

async function testAudioSpeech(
  providerData: LoadedProviderData,
  modelId: string,
  input: string
): Promise<string> {
  if (!providerData.apiKey) return 'fail: missing api key';
  if (!providerData.id.includes('openai')) return 'fail: provider does not support audio endpoint';

  const url = resolveAudioUrl(providerData, 'speech');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${providerData.apiKey}`,
  };
  const payload = {
    model: modelId,
    input,
    voice: AUDIO_VOICE,
    response_format: AUDIO_FORMAT,
  };

  try {
    await runWithTimeout(
      () => axios.post(url, payload, { headers, responseType: 'arraybuffer' }),
      `${modelId}:audio:speech`,
      AUDIO_TIMEOUT_MS
    );
    return 'ok';
  } catch (err: any) {
    return `fail: ${formatAxiosError(err)}`;
  }
}

async function testModeration(
  providerData: LoadedProviderData,
  modelId: string
): Promise<string> {
  if (!providerData.apiKey) return 'fail: missing api key';
  if (!providerData.id.includes('openai')) return 'fail: provider does not support moderation endpoint';

  const url = resolveModerationsUrl(providerData);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${providerData.apiKey}`,
  };
  const payload = {
    model: modelId,
    input: 'This is a test moderation request.',
  };

  try {
    const res = await runWithTimeout(
      () => axios.post(url, payload, { headers }),
      `${modelId}:moderations:request`,
      REQUEST_TIMEOUT_MS
    );
    const results = res?.data?.results;
    return Array.isArray(results) ? 'ok' : 'fail: empty response';
  } catch (err: any) {
    return `fail: ${formatAxiosError(err)}`;
  }
}

async function testAudioTranscription(
  providerData: LoadedProviderData,
  modelId: string
): Promise<string> {
  if (!providerData.apiKey) return 'fail: missing api key';
  if (!providerData.id.includes('openai')) return 'fail: provider does not support audio endpoint';

  const url = resolveAudioUrl(providerData, 'transcriptions');
  const form = new FormData();
  const audioBuffer = Buffer.from(SAMPLE_AUDIO_BASE64, 'base64');
  form.append('model', modelId);
  form.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'probe.wav');

  try {
    await runWithTimeout(
      () => axios.post(url, form, { headers: { 'Authorization': `Bearer ${providerData.apiKey}` } }),
      `${modelId}:audio:transcriptions`,
      AUDIO_TIMEOUT_MS
    );
    return 'ok';
  } catch (err: any) {
    return `fail: ${formatAxiosError(err)}`;
  }
}

async function testCapability(
  providerData: LoadedProviderData,
  modelId: string,
  caps: Set<ModelCapability>,
  mode: 'stream' | 'normal',
  endpointHint?: EndpointHint,
  testName: string = 'text',
  imageUrlOverride?: string
): Promise<string> {
  if (isModerationModelId(modelId)) {
    if (testName === 'text') {
      return testModeration(providerData, modelId);
    }
    return 'skip: moderation-only model';
  }

  const audioKind = classifyAudioOnlyModel(modelId);
  const isOpenAIProvider = providerData.id.includes('openai');
  if (audioKind === 'tts' && testName === 'audio_output' && isOpenAIProvider) {
    const prompt = `${getProbePrompt(testName, false)} [probe:${testName}]`;
    return testAudioSpeech(providerData, modelId, prompt);
  }
  if (audioKind === 'stt' && testName === 'audio_input' && isOpenAIProvider) {
    return testAudioTranscription(providerData, modelId);
  }

  const prefersResponsesForAudio = providerData.id.includes('openai')
    && (testName === 'audio_input' || testName === 'audio_output')
    && !endpointHint;
  const effectiveEndpointHint = prefersResponsesForAudio ? 'responses' : endpointHint;
  const provider = buildProviderInstance(providerData, effectiveEndpointHint);
  let forceAudioOnlyOutput = audioKind === 'tts';
  let audioOnlyRetried = false;

  const buildTestMessage = () => {
    const message = buildMessage(modelId, caps, mode, testName, imageUrlOverride, { audioOnlyOutput: forceAudioOnlyOutput });
    if (effectiveEndpointHint === 'responses') {
      message.useResponsesApi = true;
    } else if (effectiveEndpointHint === 'chat') {
      message.useResponsesApi = false;
    }
    return message;
  };

  while (true) {
    try {
      if (mode === 'stream' && typeof (provider as any).sendMessageStream === 'function') {
        const message = buildTestMessage();
        const stream = await runWithTimeout(async () => (provider as any).sendMessageStream(message), `${modelId}:${mode}:open-stream`);
        const first = await runWithTimeout(() => stream.next(), `${modelId}:${mode}:first-chunk`);
        if ((first as any).done) return 'fail: empty stream';
        return 'ok';
      }
      const timeoutOverride = testName === 'image_output'
        ? IMAGE_TIMEOUT_MS
        : (testName === 'audio_output' ? AUDIO_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      const message = buildTestMessage();
      const res = await runWithTimeout(() => provider.sendMessage(message), `${modelId}:${mode}:request`, timeoutOverride);
      if (testName === 'tool_calling') {
        const toolCalls = (res as any)?.tool_calls;
        return Array.isArray(toolCalls) && toolCalls.length > 0
          ? 'ok'
          : 'fail: missing tool_calls';
      }
      return res && typeof res.response === 'string' ? 'ok' : 'fail: empty response';
    } catch (err: any) {
      const message = String(err?.message || 'unknown error');
      const lower = message.toLowerCase();
      if (
        testName === 'audio_output'
        && !forceAudioOnlyOutput
        && !audioOnlyRetried
        && lower.includes('requested combination of response modalities')
        && lower.includes('audio')
      ) {
        forceAudioOnlyOutput = true;
        audioOnlyRetried = true;
        continue;
      }
      return `fail: ${message}`;
    }
  }
}

async function testLegacyCompletion(
  providerData: LoadedProviderData,
  modelId: string
): Promise<string> {
  if (!providerData.apiKey) return 'fail: missing api key';
  const url = resolveCompletionsUrl(providerData);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${providerData.apiKey}`,
  };
  const data = {
    model: modelId,
    prompt: 'Say hello in one short sentence.',
    max_tokens: 32,
    temperature: 0.2,
  };

  try {
    const res = await runWithTimeout(
      () => axios.post(url, data, { headers }),
      `${modelId}:completions:request`,
      REQUEST_TIMEOUT_MS
    );
    const text = res?.data?.choices?.[0]?.text;
    return typeof text === 'string' && text.trim().length > 0 ? 'ok' : 'fail: empty response';
  } catch (err: any) {
    return `fail: ${err?.message || 'unknown error'}`;
  }
}

async function validateProviderKey(
  provider: LoadedProviderData
): Promise<{ ok: boolean; hasQuota: boolean; reason?: string; indeterminate?: boolean }> {
  const key = provider.apiKey || '';
  if (!key) return { ok: false, hasQuota: false, reason: 'missing api key' };

  const family = resolveProviderFamily(provider.id);
  if (!['openai', 'anthropic', 'openrouter', 'gemini', 'deepseek', 'xai'].includes(family)) {
    return { ok: true, hasQuota: true };
  }

  try {
    const status = await checkKeyHealth(family, key);
    if (status.health === 'healthy') {
      return { ok: true, hasQuota: true };
    }
    if (status.health === 'no-quota') {
      return { ok: true, hasQuota: false, reason: status.error || 'quota exceeded' };
    }
    if (status.health === 'invalid') {
      return { ok: false, hasQuota: false, reason: status.error || 'invalid key' };
    }
    return {
      ok: false,
      hasQuota: true,
      reason: status.error || 'health check indeterminate',
      indeterminate: true,
    };
  } catch (err: any) {
    return {
      ok: false,
      hasQuota: true,
      reason: err?.message || String(err),
      indeterminate: true,
    };
  }

  return { ok: true, hasQuota: true };
}

function inferTestModes(
  modelId: string,
  modelCaps: ModelCapability[],
  testAllCaps: boolean
): Array<{ name: string; caps: Set<ModelCapability>; mode: 'stream' | 'normal' }> {
  const audioKind = classifyAudioOnlyModel(modelId);
  const isImageGen = isImageGenerationModelId(modelId);
  if (isModerationModelId(modelId)) {
    return [{ name: 'text', caps: new Set<ModelCapability>(['text']), mode: 'normal' }];
  }
  const baseCaps = testAllCaps
    ? ALL_CAPABILITIES
    : (modelCaps.length ? modelCaps : ['text']);
  const capsSet = new Set<ModelCapability>(baseCaps as ModelCapability[]);
  const tests: Array<{ name: string; caps: Set<ModelCapability>; mode: 'stream' | 'normal' }> = [];

  if (audioKind === 'tts') {
    capsSet.add('audio_output');
    if (capsSet.has('audio_output')) {
      tests.push({ name: 'audio_output', caps: new Set<ModelCapability>(['text', 'audio_output']), mode: 'normal' });
    }
    return tests;
  }

  if (audioKind === 'stt') {
    capsSet.add('audio_input');
    if (capsSet.has('audio_input')) {
      tests.push({ name: 'audio_input', caps: new Set<ModelCapability>(['text', 'audio_input']), mode: 'normal' });
    }
    return tests;
  }

  if (isImageGen) {
    if (!capsSet.has('image_output')) capsSet.add('image_output');
    if (capsSet.has('image_output')) tests.push({ name: 'image_output', caps: new Set<ModelCapability>(['text', 'image_output']), mode: 'normal' });
    if (capsSet.has('image_input')) tests.push({ name: 'image_input', caps: new Set<ModelCapability>(['text', 'image_input']), mode: 'normal' });
    return tests;
  }

  // Text baseline always
  tests.push({ name: 'text', caps: new Set<ModelCapability>(['text']), mode: 'normal' });

  if (capsSet.has('image_input')) tests.push({ name: 'image_input', caps: new Set<ModelCapability>(['text', 'image_input']), mode: 'normal' });
  if (capsSet.has('image_output')) tests.push({ name: 'image_output', caps: new Set<ModelCapability>(['text', 'image_output']), mode: 'normal' });
  if (capsSet.has('audio_input')) tests.push({ name: 'audio_input', caps: new Set<ModelCapability>(['text', 'audio_input']), mode: 'normal' });
  if (capsSet.has('audio_output')) tests.push({ name: 'audio_output', caps: new Set<ModelCapability>(['text', 'audio_output']), mode: 'normal' });

  // Streaming probe for any model (uses same payload as text)
  tests.push({ name: 'streaming', caps: new Set<ModelCapability>(['text']), mode: 'stream' });

  // Tool calling probe (non-capability, validates tool call support)
  tests.push({ name: 'tool_calling', caps: new Set<ModelCapability>(['text']), mode: 'normal' });

  // Heuristic realtime: name contains 'realtime'
  if (modelId.toLowerCase().includes('realtime')) {
    tests.push({ name: 'realtime', caps: new Set<ModelCapability>(['text']), mode: 'stream' });
  }

  return tests;
}

async function main() {
  await dataManager.waitForRedisReadyAndBackfill();
  const modelsRaw = await dataManager.load<ModelsFileStructure>('models');
  const allProviders = await dataManager.load<LoadedProviders>('providers');
  const initialProviderModelIds = new Map<string, Set<string>>();
  allProviders.forEach((provider) => {
    initialProviderModelIds.set(provider.id, new Set(Object.keys(provider.models || {})));
  });
  let providers = [...allProviders];
  const totalModels = modelsRaw.data.length;
  const syntheticProvider = buildSyntheticProvider(
    (modelsRaw.data as Array<{ id: string }>).map((model) => model.id).filter((id) => modelMatchesFilters(id))
  );
  if (syntheticProvider) {
    providers = [syntheticProvider, ...providers.filter((provider) => provider.id !== syntheticProvider.id)];
  }
  const totalProviders = allProviders.length + (syntheticProvider ? 1 : 0);

  if (PROVIDER_FILTERS.length > 0 || PROVIDER_FAMILIES.length > 0) {
    providers = providers.filter((p) => providerMatchesFilters(p.id));
    if (providers.length === 0) {
      console.warn('No providers matched the requested filters. Exiting.');
      return;
    }
  }

  const supportedModelIds = new Set<string>();
  providers.forEach((provider) => {
    for (const modelId of Object.keys(provider.models || {})) {
      supportedModelIds.add(modelId);
    }
  });

  const models = (modelsRaw.data as Array<{ id: string; capabilities?: ModelCapability[] }>)
    .filter((model) => supportedModelIds.has(model.id))
    .filter((model) => modelMatchesFilters(model.id));

  if (models.length === 0) {
    if (KEYCHECK_ONLY) {
      console.warn('No models available after provider filtering. Running key checks only.');
    } else {
      console.warn('No models available after provider filtering. Exiting.');
      return;
    }
  }

  const probeTested = loadProbeTested();
  const capabilitySkipStore = probeTested.capability_skips ?? (probeTested.capability_skips = {});
  let providersChanged = false;

  // Pre-pass: assign known capabilities to ALL models that don't have them
  // This runs before any probing/skipping so even models blocked by rate limits get capabilities
  let knownCapsAssigned = 0;
  for (const model of models) {
    const capSet = new Set<ModelCapability>(
      Array.isArray(model.capabilities) ? (model.capabilities as ModelCapability[]) : []
    );
    let capsChanged = false;
    const addCaps = (caps: ModelCapability[]) => {
      for (const cap of caps) {
        if (!capSet.has(cap)) {
          capSet.add(cap);
          capsChanged = true;
        }
      }
    };
    const storedCaps = inferCapabilitiesFromStoredResults(probeTested.data?.[model.id]);
    if (storedCaps.length > 0) {
      addCaps(storedCaps);
    }
    const knownCaps = getKnownCapabilities(model.id);
    if (knownCaps) {
      addCaps(knownCaps.caps);
      const pt = probeTested.data[model.id] || {};
      for (const cap of knownCaps.caps) {
        if (!pt[cap]) pt[cap] = `ok (known: ${knownCaps.reason})`;
      }
      if (!pt._status) pt._status = `ok (${knownCaps.reason})`;
      probeTested.data[model.id] = pt;
    }
    // Fine-tunes get text capability
    if (isFineTunedModel(model.id)) {
      addCaps(['text']);
      const pt = probeTested.data[model.id] || {};
      if (!pt.text) pt.text = 'ok (fine-tune — assumed text)';
      if (!pt._status) pt._status = 'ok (fine-tune)';
      probeTested.data[model.id] = pt;
    }
    if (capsChanged) {
      (model as any).capabilities = ALL_CAPABILITIES.filter((cap) => capSet.has(cap));
      providersChanged = true;
      knownCapsAssigned++;
      activatePendingModelProviders(model.id);
    }
  }
  if (knownCapsAssigned > 0) {
    console.log(`Pre-pass: assigned known capabilities to ${knownCapsAssigned} models.`);
  }

  allProviders.forEach((provider, idx) => {
    if (!providerOrderIndex.has(provider.id)) providerOrderIndex.set(provider.id, idx);
  });

  console.log(`Loaded ${totalModels} models and ${totalProviders} providers.`);
  if (providers.length !== totalProviders || models.length !== totalModels) {
    const providerNote = `${providers.length}/${totalProviders} providers`;
    const modelNote = `${models.length}/${totalModels} models`;
    const familyNote = PROVIDER_FAMILIES.length ? ` families=${PROVIDER_FAMILIES.join(',')}` : '';
    const filterNote = PROVIDER_FILTERS.length ? ` filters=${PROVIDER_FILTERS.join(',')}` : '';
    const modelFilterNote = MODEL_FILTERS.length ? ` model_filters=${MODEL_FILTERS.join(',')}` : '';
    console.log(`Provider filter active (${providerNote}, ${modelNote}).${familyNote}${filterNote}${modelFilterNote}`);
  }

  const probeHints: ProbeLogHints = USE_PROBE_LOG
    ? loadProbeLogHints()
    : { modelEndpointHints: new Map(), modelSkipReasons: new Map(), testSkipReasons: new Map(), testFailReasons: new Map() };
  if (USE_PROBE_LOG) {
    console.log(`Loaded probe log hints for ${probeHints.modelEndpointHints.size} model(s).`);
  }
  const quotaDisabledProviders = USE_PROBE_LOG ? loadQuotaDisabledProviders() : new Set<string>();

  const providerValidity = new Map<string, { ok: boolean; hasQuota: boolean }>();
  const providerBlockedCaps = new Map<string, Set<ModelCapability>>();
  const keyStatusCache = new Map<string, { ok: boolean; hasQuota: boolean; reason?: string; indeterminate?: boolean }>();
  const providerQueue = [...providers];

  function disableProvider(provider: LoadedProviderData, reason: string) {
    if (provider.disabled) return;
    provider.disabled = true;
    providersChanged = true;
    appendProbeLog({ type: 'provider_disabled', providerId: provider.id, reason });
  }

  function shouldPersistQuotaDisable(provider: LoadedProviderData): boolean {
    // Treat quota/rate-limit findings as temporary capacity signals for all
    // families. The runtime cooldown logic already handles these without
    // collapsing the provider catalog into a stale disabled set.
    return false;
  }

  function removeModelFromProvider(provider: LoadedProviderData, modelId: string, reason: string) {
    if (!provider.models || !provider.models[modelId]) return;
    delete provider.models[modelId];
    providersChanged = true;
    appendProbeLog({ type: 'provider_model_removed', providerId: provider.id, modelId, reason });
  }

  function activatePendingModelProviders(modelId: string) {
    let changed = false;
    for (const provider of allProviders) {
      const modelData = provider.models?.[modelId] as any;
      if (!modelData?.pending_probe) continue;
      modelData.pending_probe = false;
      modelData.disabled = false;
      modelData.disabled_at = undefined;
      modelData.disable_count = 0;
      modelData.consecutive_errors = 0;
      changed = true;
    }
    if (changed) {
      providersChanged = true;
    }
  }

  function blockProviderCapability(providerId: string, cap: ModelCapability, reason: string) {
    let caps = providerBlockedCaps.get(providerId);
    if (!caps) {
      caps = new Set<ModelCapability>();
      providerBlockedCaps.set(providerId, caps);
    }
    if (!caps.has(cap)) {
      caps.add(cap);
      appendProbeLog({ type: 'provider_cap_blocked', providerId, capability: cap, reason });
    }
  }

  function mergeProviderProbeUpdates(currentProviders: LoadedProviders, probedProviders: LoadedProviders): LoadedProviders {
    const probedById = new Map<string, LoadedProviderData>(probedProviders.map((provider) => [provider.id, provider]));
    return currentProviders.map((currentProvider) => {
      const probedProvider = probedById.get(currentProvider.id);
      if (!probedProvider) return currentProvider;

      const mergedModels = { ...(currentProvider.models || {}) } as Record<string, any>;
      const initialModels = initialProviderModelIds.get(currentProvider.id) || new Set<string>();

      for (const initialModelId of initialModels) {
        if (!(probedProvider.models || {})[initialModelId] && mergedModels[initialModelId]) {
          delete mergedModels[initialModelId];
        }
      }

      for (const [modelId, modelData] of Object.entries(probedProvider.models || {})) {
        mergedModels[modelId] = { ...(mergedModels[modelId] || {}), ...modelData };
      }

      return {
        ...currentProvider,
        ...probedProvider,
        models: mergedModels,
      };
    });
  }

  async function keyCheckWorker() {
    while (providerQueue.length > 0) {
      const provider = providerQueue.shift();
      if (!provider) return;

      const apiKey = provider.apiKey || '';
      const family = resolveProviderFamily(provider.id);
      const cacheKey = `${family}:${apiKey}`;

      let status = keyStatusCache.get(cacheKey);
      if (!status) {
        status = await validateProviderKey(provider);
        keyStatusCache.set(cacheKey, status);
      }

      providerValidity.set(provider.id, { ok: status.ok, hasQuota: status.hasQuota });
      if (!status.ok) {
        if (status.indeterminate) {
          appendProbeLog({ type: 'key_check_indeterminate', providerId: provider.id, reason: status.reason || 'health check indeterminate' });
        } else {
          disableProvider(provider, status.reason || 'invalid key');
          appendProbeLog({ type: 'key_invalid', providerId: provider.id, reason: status.reason || 'invalid key' });
        }
      } else if (!status.hasQuota) {
        if (shouldPersistQuotaDisable(provider)) {
          disableProvider(provider, 'quota exceeded');
        } else if (provider.disabled) {
          provider.disabled = false;
          providersChanged = true;
          appendProbeLog({ type: 'provider_reenabled', providerId: provider.id, reason: 'quota handled via cooldown' });
        }
        appendProbeLog({ type: 'key_no_quota', providerId: provider.id, reason: 'quota exceeded' });
      } else if (provider.disabled && quotaDisabledProviders.has(provider.id)) {
        provider.disabled = false;
        providersChanged = true;
        appendProbeLog({ type: 'provider_reenabled', providerId: provider.id, reason: 'quota restored' });
      }
    }
  }

  const keyCheckWorkers = Array.from({ length: KEYCHECK_CONCURRENCY }, () => keyCheckWorker());
  await Promise.all(keyCheckWorkers);

  if (KEYCHECK_ONLY) {
    if (providersChanged) {
      await dataManager.save('providers', allProviders);
      console.log('providers.json updated (disabled no-quota/invalid keys).');
    }
    console.log('Key-check-only mode complete. Skipped model capability probes.');
    return;
  }

  const modelQueue = models.filter((_, idx) => idx < MAX_MODELS);
  let processed = 0;

  async function workerLoop(workerId: number) {
    while (modelQueue.length > 0) {
      const model = modelQueue.shift();
      if (!model) return;

      const isLegacyCompletions = shouldSkipLegacyCompletionsModel(model.id);
      let completionsOnlyModel = isLegacyCompletions;
      const audioKind = classifyAudioOnlyModel(model.id);
      const providerTried = new Set<string>();
      let provider = pickProvider(providers, model.id, providerValidity, providerTried);
      if (!provider) {
        continue;
      }

      if (isLegacyCompletions) {
        while (provider && !provider.id.includes('openai')) {
          providerTried.add(provider.id);
          provider = pickProvider(providers, model.id, providerValidity, providerTried);
        }
        if (!provider) {
          appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: 'legacy completions model (no openai provider)' });
          continue;
        }
      }

      if (isModerationModelId(model.id)) {
        while (provider && !provider.id.includes('openai')) {
          providerTried.add(provider.id);
          provider = pickProvider(providers, model.id, providerValidity, providerTried);
        }
        if (!provider) {
          appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: 'moderation model (no openai provider)' });
          continue;
        }
      }

      // Realtime models use WebSocket API — assign known capabilities directly
      if (isRealtimeModel(model.id)) {
        const realtimeCaps: ModelCapability[] = ['text', 'audio_input', 'audio_output'];
        if (!model.capabilities || !model.capabilities.length) {
          (model as any).capabilities = realtimeCaps;
          providersChanged = true;
        }
        const pt = probeTested.data[model.id] || {};
        pt.text = 'ok (realtime)';
        pt.audio_input = 'ok (realtime)';
        pt.audio_output = 'ok (realtime)';
        pt._status = 'ok (realtime model — WebSocket only)';
        probeTested.data[model.id] = pt;
        activatePendingModelProviders(model.id);
        appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: 'realtime model (WebSocket only, capabilities assigned directly)' });
        continue;
      }

      // Assign known capabilities for models that can't be probed via standard HTTP
      const knownCaps = getKnownCapabilities(model.id);
      if (knownCaps && (!model.capabilities || !model.capabilities.length)) {
        (model as any).capabilities = knownCaps.caps;
        providersChanged = true;
        const pt = probeTested.data[model.id] || {};
        for (const cap of knownCaps.caps) {
          pt[cap] = `ok (known: ${knownCaps.reason})`;
        }
        pt._status = `ok (${knownCaps.reason})`;
        probeTested.data[model.id] = pt;
        activatePendingModelProviders(model.id);
        appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: `known capabilities assigned: ${knownCaps.reason}` });
        continue;
      }

      // Skip private fine-tuned models (tied to specific org/account, will always 404 for other keys)
      // Assign ['text'] since all fine-tunes are text models
      if (isPrivateFineTune(model.id)) {
        if (!model.capabilities || !model.capabilities.length) {
          (model as any).capabilities = ['text'];
          providersChanged = true;
        }
        appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: 'private fine-tuned model (org-specific)' });
        const pt = probeTested.data[model.id] || {};
        pt.text = 'ok (private fine-tune — assumed text)';
        pt._status = 'ok (private fine-tune)';
        probeTested.data[model.id] = pt;
        activatePendingModelProviders(model.id);
        continue;
      }

      // Handle embedding models: test via embeddings endpoint, not chat
      if (isEmbeddingModel(model.id)) {
        while (provider && !provider.id.includes('openai')) {
          providerTried.add(provider.id);
          provider = pickProvider(providers, model.id, providerValidity, providerTried);
        }
        if (!provider) {
          appendProbeLog({ type: 'probe_skip', modelId: model.id, reason: 'embedding model (no openai provider)' });
          continue;
        }
        // Test via embeddings endpoint
        try {
          const embeddingsUrl = (() => {
            const url = provider.provider_url || '';
            if (url.includes('/v1/')) return url.slice(0, url.indexOf('/v1/') + 4) + 'embeddings';
            if (url.endsWith('/v1')) return url + '/embeddings';
            return 'https://api.openai.com/v1/embeddings';
          })();
          const embRes = await axios.post(embeddingsUrl, {
            model: model.id,
            input: 'test',
          }, {
            headers: { Authorization: `Bearer ${provider.apiKey}` },
            validateStatus: () => true,
            timeout: REQUEST_TIMEOUT_MS,
          });
          const pt = probeTested.data[model.id] || {};
          if (embRes.status === 200) {
            pt.text = 'ok';
            pt._status = 'ok (embedding)';
            if (!model.capabilities || !model.capabilities.length) {
              (model as any).capabilities = ['text'];
              providersChanged = true;
            }
            activatePendingModelProviders(model.id);
          } else {
            pt.text = `fail: embeddings ${embRes.status}`;
            pt._status = `fail: embeddings ${embRes.status}`;
            appendProbeLog({ type: 'probe_fail', modelId: model.id, providerId: provider.id, test: 'text', outcome: `fail: embeddings ${embRes.status}` });
          }
          probeTested.data[model.id] = pt;
        } catch (err: any) {
          appendProbeLog({ type: 'probe_fail', modelId: model.id, providerId: provider.id, test: 'text', outcome: `fail: ${err?.message || 'unknown'}` });
        }
        continue;
      }

      const declaredCaps = Array.isArray(model.capabilities) && model.capabilities.length
        ? (model.capabilities as ModelCapability[])
        : ([] as ModelCapability[]);
      const declaredCapsSet = new Set<ModelCapability>(declaredCaps);
      const outerStoredSkips = capabilitySkipStore[model.id];
      if (outerStoredSkips) {
        let changed = false;
        for (const [cap, reason] of Object.entries(outerStoredSkips)) {
          if (isRetryableSkipReason(reason)) {
            delete outerStoredSkips[cap];
            changed = true;
          }
        }
        if (changed && Object.keys(outerStoredSkips).length === 0) {
          delete capabilitySkipStore[model.id];
        }
      }
      const declaredSkipMap = normalizeCapabilitySkips(capabilitySkipStore[model.id]);
      const testedResults = probeTested.data?.[model.id];
      const testSkipHints = probeHints.testSkipReasons.get(model.id);
      const testFailHints = probeHints.testFailReasons.get(model.id);

      if (testSkipHints) {
        for (const [test, reason] of testSkipHints.entries()) {
          if (shouldPersistCapabilitySkip(reason, test)) {
            persistCapabilitySkip(capabilitySkipStore, model.id, declaredSkipMap, test as ModelCapability, reason);
          }
        }
      }

      let tests = inferTestModes(model.id, declaredCaps, TEST_ALL_CAPS);
      tests = tests.filter((test) => {
        const cap = test.name as ModelCapability;
          const isCapabilityTest = ALL_CAPABILITIES.includes(cap);
        const testedOutcome = testedResults?.[test.name];
        const quotaSkipped = isQuotaSkipValue(testedOutcome);
        const retryable = isRetryableSkipValue(testedOutcome);
        const regionUnavailable = isImageGenerationUnavailableSkipValue(testedOutcome, test.name);
        if (testSkipHints?.has(test.name)) return false;
        if (SKIP_TESTED_OK && isOkResult(testedOutcome)) return false;
        if (isLegacyCompletions && test.name !== 'text') return false;
          if (isCapabilityTest) {
            const storedSkipReason = declaredSkipMap.get(cap);
            if (storedSkipReason && !isRetryableSkipReason(storedSkipReason)) return false;
            if (quotaSkipped) return true;
            if (retryable) return true;
            if (regionUnavailable) return true;
            if (testFailHints && testFailHints.has(test.name)) return true;
            if (declaredCapsSet.has(cap)) return false;
            // Skip capability tests that already have a definitive stored result
            if (SKIP_TESTED_OK && testedOutcome) return false;
            return true;
          }
        // Non-capability tests (e.g. streaming): re-test only transient failures
        if (retryable) return true;
        if (quotaSkipped) return true;
        if (regionUnavailable) return true;
        // Skip non-capability tests that already have a definitive stored result
        if (SKIP_TESTED_OK && testedOutcome) return false;
        return true;
      });
      if (isRelaceModel(model.id)) {
        tests = tests.filter((test) => test.name === 'text' || test.name === 'streaming');
      }
      const results: Record<string, string> = {};
      const serverErrorProviderCounts = new Map<string, number>();
      const serverErrorTestCounts = new Map<string, number>();
      const caps = new Set<ModelCapability>(declaredCaps);
      let endpointHintOverride: EndpointHint | undefined = undefined;
      const hintedEndpoint = probeHints.modelEndpointHints.get(model.id);
      if (hintedEndpoint && hintedEndpoint !== endpointHintOverride) {
        endpointHintOverride = hintedEndpoint;
      }

      const modelSkipReason = probeHints.modelSkipReasons.get(model.id);
      if (modelSkipReason) {
        continue;
      }

      while (provider) {
        if (provider.id.includes('xai') && isXaiMediaModel(model.id)) {
          results._status = 'skipped: xAI image/video model endpoint';
          appendProbeLog({ type: 'probe_skip', modelId: model.id, providerId: provider.id, reason: 'xai image/video endpoint' });
          break;
        }

        let providerExhausted = false;

        for (const test of tests) {
          const key = test.name;
          if (results[key] && (results[key].startsWith('ok') || results[key].startsWith('skip'))) continue;

          if (completionsOnlyModel && key !== 'text') {
            results[key] = 'skip: completions-only model';
            if (!results._status) results._status = 'skipped: completions-only model';
            appendProbeLog({ type: 'probe_skip', modelId: model.id, providerId: provider.id, test: key, reason: 'completions-only model' });
            continue;
          }

          const blockedCaps = providerBlockedCaps.get(provider.id);
          if (blockedCaps) {
            if (key === 'image_input' && blockedCaps.has('image_input')) {
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                provider = nextProvider;
                providerExhausted = true;
                break;
              }
              results[key] = 'skip: image input rate limit (limit 0)';
              if (!results._status) results._status = 'skipped: image input rate limit (limit 0)';
              continue;
            }
            if (key === 'image_output' && blockedCaps.has('image_output')) {
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                provider = nextProvider;
                providerExhausted = true;
                break;
              }
              results[key] = 'skip: image generation unavailable in provider region';
              if (!results._status) results._status = 'skipped: image generation unavailable in provider region';
              continue;
            }
            if (key === 'audio_input' && blockedCaps.has('audio_input')) {
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                provider = nextProvider;
                providerExhausted = true;
                break;
              }
              results[key] = 'skip: audio input rate limit (limit 0)';
              if (!results._status) results._status = 'skipped: audio input rate limit (limit 0)';
              continue;
            }
          }

          const hintedSkip = testSkipHints?.get(key);
          if (hintedSkip) {
            results[key] = `skip: ${hintedSkip}`;
            if (!results._status) results._status = `skipped: ${hintedSkip}`;
            continue;
          }

          if (endpointHintOverride === 'interactions') {
            results[key] = 'skip: interactions-only model';
            if (!results._status) results._status = 'skipped: interactions-only model';
            appendProbeLog({ type: 'probe_skip', modelId: model.id, providerId: provider.id, test: key, reason: 'interactions-only model' });
            continue;
          }

          let outcome = '';
          let outcomeLower = '';
          let skipReason: string | null = null;
          let skipScope: 'model' | 'test' | null = null;
          let rotateProvider = false;
          let mode: 'stream' | 'normal' = test.mode;
          if (key === 'audio_output' && provider.id.includes('openrouter')) {
            mode = 'stream';
          }
          let imageUrlIndex = 0;
          const endpointTried = new Set<EndpointHint>();
          if (endpointHintOverride) endpointTried.add(endpointHintOverride);
          let retriesLeft = MAX_RETRIES;

          while (true) {
            const imageUrlOverride = key === 'image_input' ? SAMPLE_IMAGE_URLS[imageUrlIndex] : undefined;
            if (!provider) {
              outcome = 'fail: no valid provider';
              outcomeLower = outcome.toLowerCase();
              break;
            }
            // TypeScript fix: provider is guaranteed non-null here
            outcome = await withProviderLimit(
              provider.id,
              () => {
                if (isLegacyCompletions && key === 'text') {
                  return testLegacyCompletion(provider as LoadedProviderData, model.id);
                }
                return testCapability(provider as LoadedProviderData, model.id, test.caps, mode, endpointHintOverride, key, imageUrlOverride);
              }
            );
            outcomeLower = outcome.toLowerCase();

            if (!outcome.startsWith('ok') && isServerError(outcomeLower)) {
              const prevCount = serverErrorTestCounts.get(key) || 0;
              const nextCount = prevCount + 1;
              serverErrorTestCounts.set(key, nextCount);
              if (MAX_SERVER_ERROR_RETRIES > 0 && nextCount >= MAX_SERVER_ERROR_RETRIES) {
                skipReason = 'unsupported (server errors)';
                skipScope = 'test';
                break;
              }
              markServerError(provider.id);
            }

            if (outcome.startsWith('ok')) break;

            if (outcomeLower.includes('unexpected response structure') && (key === 'image_output' || key === 'audio_output')) {
              outcome = 'ok (non-text output)';
              break;
            }

            if (key === 'audio_output' && outcomeLower.includes('audio output requires stream') && mode !== 'stream') {
              mode = 'stream';
              continue;
            }

            if (key === 'audio_output' && outcomeLower.includes("does not support 'generatecontent'") && mode !== 'stream') {
              mode = 'stream';
              continue;
            }

            if (key === 'image_input' && imageUrlIndex + 1 < SAMPLE_IMAGE_URLS.length) {
              const currentUrl = SAMPLE_IMAGE_URLS[imageUrlIndex];
              if (shouldSwapImageUrl(outcomeLower, currentUrl)) {
                imageUrlIndex += 1;
                continue;
              }
            }

            if (key === 'image_input' && isImageInputLimitZero(outcomeLower)) {
              blockProviderCapability(provider.id, 'image_input', 'input-images rate limit: limit 0');
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                provider = nextProvider;
                providerExhausted = true;
                rotateProvider = true;
                break;
              }
              skipReason = 'image input rate limit (limit 0)';
              skipScope = 'test';
              break;
            }

            if (key === 'image_output' && isImageGenerationUnavailable(outcomeLower, key)) {
              blockProviderCapability(provider.id, 'image_output', 'image generation unavailable in country');
              removeModelFromProvider(provider, model.id, 'image generation unavailable in provider region');
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                provider = nextProvider;
                providerExhausted = true;
                rotateProvider = true;
                break;
              }
              skipReason = 'image generation unavailable in provider region';
              skipScope = 'test';
              break;
            }

            const detectedHint = detectEndpointHint(outcomeLower);
            if (detectedHint && detectedHint !== endpointHintOverride && !endpointTried.has(detectedHint)) {
              endpointHintOverride = detectedHint;
              endpointTried.add(detectedHint);

              if (detectedHint === 'interactions') {
                skipReason = 'interactions-only model';
                skipScope = 'model';
                break;
              }

              if (outcome.startsWith('fail')) {
                continue;
              }
            }

            if (detectedHint === 'responses' && endpointTried.has('responses') && outcomeLower.includes('only supported in v1/responses')) {
              skipReason = 'responses-only model';
              skipScope = 'model';
              break;
            }

            if (isCompletionsOnlyError(outcomeLower)) {
              if (shouldTreatCompletionsErrorAsResponses(model.id) && !endpointTried.has('responses')) {
                endpointHintOverride = 'responses';
                endpointTried.add('responses');
                if (outcome.startsWith('fail')) {
                  continue;
                }
              }
              if (key === 'text' && provider.id.includes('openai')) {
                const completionOutcome = await withProviderLimit(
                  provider.id,
                  () => testLegacyCompletion(provider as LoadedProviderData, model.id)
                );
                if (completionOutcome.startsWith('ok')) {
                  completionsOnlyModel = true;
                  outcome = completionOutcome;
                  outcomeLower = outcome.toLowerCase();
                  break;
                }
                outcome = completionOutcome;
                outcomeLower = outcome.toLowerCase();
              }
              completionsOnlyModel = true;
              skipReason = 'completions-only model';
              skipScope = key === 'text' ? 'model' : 'test';
              break;
            }

            if (isQuotaError(outcomeLower)) {
              skipReason = 'quota exceeded';
              skipScope = 'model';
              break;
            }

            if (isAccessError(outcomeLower)) {
              const accessReason = (outcomeLower.includes('organization must be verified') || outcomeLower.includes('verify organization'))
                ? 'organization verification required'
                : 'no access';
              removeModelFromProvider(provider as LoadedProviderData, model.id, accessReason);
              providerTried.add(provider.id);
              const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
              if (nextProvider) {
                appendProbeLog({ type: 'probe_retry', modelId: model.id, providerId: provider.id, test: key, reason: `${accessReason}: switching provider` });
                provider = nextProvider;
                providerExhausted = true;
                rotateProvider = true;
                break;
              }
              skipReason = accessReason === 'organization verification required' ? 'no access (organization verification required)' : 'no access';
              skipScope = 'model';
              break;
            }

            if (isDataPolicyError(outcomeLower)) {
              skipReason = 'data policy restriction';
              skipScope = 'model';
              break;
            }

            if (isModelNotFoundError(outcomeLower)) {
              skipReason = 'model not found';
              skipScope = 'model';
              break;
            }

            if (isCapacityError(outcomeLower)) {
              skipReason = 'no available capacity';
              skipScope = 'model';
              break;
            }

            if (isToolsRequiredError(outcomeLower)) {
              skipReason = 'requires tools';
              skipScope = 'model';
              break;
            }

            if (key === 'tool_calling' && isToolUnsupportedError(outcomeLower)) {
              skipReason = 'tool calling unsupported';
              skipScope = 'test';
              break;
            }

            const unsupported = classifyUnsupportedCapability(outcomeLower, key);
            if (unsupported) {
              skipReason = unsupported;
              skipScope = 'test';
              break;
            }

            if (isStreamingUnsupportedError(outcomeLower, key, mode)) {
              skipReason = 'streaming unsupported';
              skipScope = 'test';
              break;
            }

            if ((isRateLimitError(outcomeLower) || isTimeoutError(outcomeLower)) && retriesLeft > 0) {
              const isRateLimited = isRateLimitError(outcomeLower);
              if (isRateLimited) {
                markRateLimited(provider.id);
              } else {
                markServerError(provider.id);
              }

              const attempt = MAX_RETRIES - retriesLeft + 1;
              const waitBase = isRateLimited ? RATE_LIMIT_WAIT_MS : TIMEOUT_WAIT_MS;
              if (waitBase > 0) {
                const waitMs = isRateLimited ? waitBase * Math.pow(2, Math.max(0, attempt - 1)) : waitBase;
                await sleep(waitMs);
              }
              retriesLeft -= 1;

              if (isRateLimited) {
                continue;
              }

              const canRotateProvider = MAX_RATE_LIMIT_TIMEOUT_RETRIES <= 0
                || providerTried.size < MAX_RATE_LIMIT_TIMEOUT_RETRIES;
              if (!canRotateProvider) {
                continue;
              }

              const exhaustedProviders = new Set(providerTried);
              exhaustedProviders.add(provider.id);
              const nextProvider = pickProvider(
                providers,
                model.id,
                providerValidity,
                exhaustedProviders,
                { readyOnly: true },
              );
              if (nextProvider) {
                appendProbeLog({ type: 'probe_retry', modelId: model.id, providerId: provider.id, test: key, reason: 'rate limit/timeout: switching provider' });
                providerTried.add(provider.id);
                provider = nextProvider;
                providerExhausted = true;
                rotateProvider = true;
                break;
              }
              continue;
            }

            if (isTransientError(outcomeLower) && retriesLeft > 0) {
              const attempt = MAX_RETRIES - retriesLeft + 1;
              retriesLeft -= 1;
              await sleep(RETRY_BACKOFF_MS * attempt);
              continue;
            }

            if (isRateLimitError(outcomeLower)) {
              skipReason = 'rate limited';
              skipScope = 'test';
              break;
            }

            if (isTimeoutError(outcomeLower)) {
              skipReason = 'timeout';
              skipScope = 'test';
              break;
            }

            if (isServerError(outcomeLower)) {
              if (isImageGenerationModelId(model.id)) {
                const prevCount = serverErrorProviderCounts.get(key) || 0;
                const nextCount = prevCount + 1;
                serverErrorProviderCounts.set(key, nextCount);
                if (MAX_SERVER_ERROR_PROVIDERS > 0 && nextCount >= MAX_SERVER_ERROR_PROVIDERS) {
                  skipReason = 'server error';
                  skipScope = 'test';
                  break;
                }
                providerTried.add(provider.id);
                const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
                if (nextProvider) {
                  appendProbeLog({ type: 'probe_retry', modelId: model.id, providerId: provider.id, test: key, reason: 'server error: switching provider' });
                  provider = nextProvider;
                  providerExhausted = true;
                  rotateProvider = true;
                  break;
                }
              }
              skipReason = 'server error';
              skipScope = 'test';
              break;
            }

            break;
          }

          if (rotateProvider) {
            break;
          }

          if (skipReason === 'quota exceeded') {
            if (shouldPersistQuotaDisable(provider)) {
              disableProvider(provider, 'quota exceeded');
            }
            providerValidity.set(provider.id, { ok: true, hasQuota: false });
            appendProbeLog({ type: 'provider_no_quota', providerId: provider.id, modelId: model.id, test: key, reason: 'quota exceeded' });
            providerTried.add(provider.id);
            const nextProvider = pickProvider(providers, model.id, providerValidity, providerTried);
            if (!nextProvider) {
              const skipOutcome = `skip: quota exceeded (${key})`;
              results[key] = skipOutcome;
              results._status = 'skipped: quota exceeded';
              appendProbeLog({ type: 'probe_skip', modelId: model.id, providerId: provider.id, test: key, reason: 'quota exceeded' });
              provider = null;
            } else {
              provider = nextProvider;
              providerExhausted = true;
            }
            break;
          }

          if (skipReason) {
            if (skipScope === 'test' && shouldPersistCapabilitySkip(skipReason, key)) {
              persistCapabilitySkip(capabilitySkipStore, model.id, declaredSkipMap, key as ModelCapability, skipReason);
            }
            if (skipReason === 'rate limited') {
              results[key] = 'retry: rate limited';
            } else {
              const skipOutcome = skipReason === 'quota exceeded'
                ? `skip: quota exceeded (${key})`
                : `skip: ${skipReason}`;
              results[key] = skipOutcome;
            }
            if (skipScope === 'model') {
              results._status = `skipped: ${skipReason}`;
            }
            appendProbeLog({ type: 'probe_skip', modelId: model.id, providerId: provider.id, test: key, reason: skipReason });
            if (skipScope === 'model') break;
            continue;
          }

          results[key] = outcome;
          console.log(`${model.id} [${key}] -> ${outcome}`);

          if (outcome.startsWith('ok')) {
            rateLimitBackoff.delete(provider.id);
            rateLimitUntil.delete(provider.id);
            serverErrorBackoff.delete(provider.id);
            serverErrorUntil.delete(provider.id);
          if (key === 'text') {
            caps.add('text');
          }
          if (key === 'image_input') {
            caps.add('image_input');
          }
          if (key === 'image_output') {
            caps.add('image_output');
          }
          if (key === 'audio_input') {
            caps.add('audio_input');
          }
          if (key === 'audio_output') {
            caps.add('audio_output');
          }
          if (key === 'tool_calling') {
            caps.add('tool_calling');
          }
          } else {
            appendProbeLog({ type: 'probe_fail', modelId: model.id, providerId: provider.id, test: key, outcome });
          }

          if (STOP_ON_FAIL && outcome.startsWith('fail')) {
            await dataManager.save('models', modelsRaw);
            console.log(`Stopping early due to failure (CAP_TEST_STOP_ON_FAIL=1).`);
            process.exit(1);
          }
        }

        if (!providerExhausted) break;
      }

      const nextCaps = ALL_CAPABILITIES.filter((cap) => caps.has(cap));
      model.capabilities = nextCaps;
      if (nextCaps.length > 0) {
        activatePendingModelProviders(model.id);
      }
      const finalStoredSkips = capabilitySkipStore[model.id];
      if (finalStoredSkips) {
        for (const cap of Object.keys(finalStoredSkips)) {
          if (nextCaps.includes(cap as ModelCapability)) {
            delete finalStoredSkips[cap];
          }
        }
        if (Object.keys(finalStoredSkips).length === 0) {
          delete capabilitySkipStore[model.id];
        }
      }
      processed += 1;

      if (Object.keys(results).length > 0) {
        const existing = probeTested.data[model.id] || {};
        const merged = { ...existing, ...results };
        if (!('_status' in results) && 'image_output' in results) {
          const status = typeof merged._status === 'string' ? merged._status.toLowerCase() : '';
          if (status.includes('image generation unavailable')) {
            delete merged._status;
          }
        }
        probeTested.data[model.id] = merged;
      }
    }
  }

  const workers = Array.from({ length: PROBE_CONCURRENCY }, (_, idx) => workerLoop(idx));
  await Promise.all(workers);

  await dataManager.save('models', modelsRaw);
  probeTested.updated_at = new Date().toISOString();
  saveProbeTested(probeTested);
  if (providersChanged) {
    await dataManager.updateWithLock<LoadedProviders>('providers', async (currentProviders) => {
      return mergeProviderProbeUpdates(currentProviders, allProviders);
    });
    console.log('providers.json updated (disabled no-quota/invalid keys).');
  }
  console.log('models.json updated with capability updates.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
