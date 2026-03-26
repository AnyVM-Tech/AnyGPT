import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { messageHandler } from '../providers/handler.js';
import { IMessage, type ModelCapability } from '../providers/interfaces.js';
import {
	type StoredResponsesHistoryEntry,
	type ResponsesHistoryStoragePlan,
	buildResponsesHistoryStoragePlan,
	cloneResponsesHistoryValue,
	loadResponsesHistoryEntry,
	saveResponsesHistoryEntry,
	buildStoredResponsesHistoryOutput,
	mergeResponsesHistoryInput
} from '../modules/responsesHistory.js';
import {
	buildResponsesCompletedEvent,
	buildResponsesContentPartAddedEvent,
	buildResponsesContentPartDoneEvent,
	buildResponsesCreatedEvent,
	buildResponsesFunctionCallArgumentsDoneEvent,
	buildResponsesOutputItemAddedEvent,
	buildResponsesOutputItemDoneEvent,
	buildResponsesOutputTextDeltaEvent,
	buildResponsesOutputTextDoneEvent,
	buildResponsesUsage,
	buildResponsesResponseObject,
	createResponsesItemId,
	createResponsesMessageItem,
	createResponsesReasoningItem
} from '../modules/openaiResponsesFormat.js';
import {
	buildResponsesCompactionSummary,
	createResponsesCompactionItem,
	estimateResponsesCompactionTokens,
	expandResponsesCompactionItems,
	findResponsesCompactionKeepStartIndex,
	resolveResponsesCompactionThreshold
} from '../modules/responsesCompaction.js';
import {
	extractTextFromContent,
	extractInputAudioFromContent,
	extractImageUrlFromContent,
	extractTextFromMessages,
	extractInputAudioFromMessages,
	extractImageUrlFromMessages,
	extractTextFromResponsesInput,
	extractInputAudioFromResponsesInput,
	extractImageUrlFromResponsesInput
} from '../modules/contentExtraction.js';
import {
	normalizeInputAudio,
	detectMimeTypeFromBuffer,
	detectMimeTypeFromBase64,
	isLikelyBase64,
	parseMultipartBody
} from '../modules/mediaParsing.js';
import { inlineImageUrls as inlineImageUrlsShared } from '../modules/imageFetch.js';
import {
	isImageModelId,
	isNanoBananaModel,
	ensureNanoBananaModalities,
	isNonChatModel,
	composeAssistantContent,
	inferToolCallsFromJsonText,
	filterValidChatMessages
} from '../modules/openaiRouteUtils.js';
import {
	generateUserApiKey, // Now async
	extractMessageFromRequestBody,
	updateUserTokenUsage, // Now async
	validateApiKeyAndUsage // Now async
} from '../modules/userData.js';
// Import TierData type for Request extension
import { TierData, type KeysFile } from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js';
import redis from '../modules/db.js';
import {
	buildKeyDetailsPayload,
	loadKeysLiveSnapshot
} from '../modules/keyUsage.js';
import {
	buildModelAccessError,
	isModelAllowedForTier
} from '../modules/planAccess.js';
import { incrementSharedRateLimitCounters } from '../modules/rateLimitRedis.js';
import {
	enforceInMemoryRateLimit,
	evaluateSharedRateLimit,
	RequestTimestampStore
} from '../modules/rateLimit.js';
import {
	runAuthMiddleware,
	runRateLimitMiddleware,
	extractBearerToken,
	normalizeApiKey
} from '../modules/middlewareFactory.js';
import {
	dataManager,
	LoadedProviders,
	LoadedProviderData,
	type ModelsFileStructure
} from '../modules/dataManager.js';
import { logger } from '../modules/logger.js';
import {
	redactAuthorizationHeader,
	redactToken,
	hashToken
} from '../modules/redaction.js';
import { fetchWithTimeout } from '../modules/http.js';
import {
	RequestQueue,
	QueueOverloadedError,
	requestQueue
} from '../modules/requestQueue.js';
import {
	getBackpressureRetryAfterSeconds,
	readJsonRequestBody,
	withBufferedRequestBody
} from '../modules/requestIntake.js';
import {
	getCachedGeneratedImage,
	getGeneratedImageCacheControlHeader
} from '../modules/generatedImageStore.js';
import {
	getHeaderValue,
	normalizeImageFetchReferer,
	extractUsageTokens,
	createSseDataParser,
	startSseHeartbeat
} from '../modules/openaiRequestSupport.js';
import {
	authAndUsageMiddleware,
	authKeyOnlyMiddleware,
	createRateLimitMiddleware,
	formatRateLimitMessage,
	getServiceTierForUserTier,
	isGeminiFreeTierZeroQuota
} from '../modules/openaiRouteSupport.js';
import {
	enforceModelCapabilities,
	listAnyVideoProviders,
	listVideoGenProviders,
	pickEmbeddingProviderKey,
	pickOpenAIProviderKey
} from '../modules/openaiProviderSelection.js';
import {
	AUDIO_CONTENT_TYPES,
	forwardTtsToOpenAI,
	forwardSttToOpenAI
} from '../modules/openaiAudio.js';
import {
	handleImageGenFallbackFromChatOrResponses,
	handleVideoGenFallbackFromChatOrResponses,
	requestImageEdit,
	requestImageGeneration,
	requestVideoGeneration,
	requestVideoGenerationMultipart
} from '../modules/openaiFallbacks.js';
import {
	buildGeminiVideoCacheUpdate,
	buildGeminiVideoStatusPayload,
	downloadGeminiVideoContent,
	getGeminiVideoOperation,
	isGeminiVideoRequestId,
	type VideoRequestCacheProvider
} from '../modules/geminiVideo.js';
import {
	buildVideoRequestCacheProvider,
	resolveVideoRequestCacheTtlMs
} from '../modules/videoRequestCache.js';
import {
	createInteractionToken,
	executeGeminiInteraction,
	getInteractionsSigningSecret,
	normalizeDeepResearchModel,
	verifyInteractionToken,
	extractOpenAIResponseFormat,
	InteractionRequest,
	InteractionTokenClient
} from '../modules/interactions.js';
import {
	readEnvNumber,
	readEnvBool,
	readEnvCsv,
	BASE64_DATA_URL_GLOBAL,
	IMAGE_INPUT_TOKENS_PER_KB,
	IMAGE_OUTPUT_TOKENS_PER_KB,
	AUDIO_INPUT_TOKENS_PER_KB,
	AUDIO_OUTPUT_TOKENS_PER_KB,
	IMAGE_URL_FALLBACK_TOKENS,
	AUDIO_DATA_FALLBACK_TOKENS,
	IMAGE_MIN_TOKENS,
	AUDIO_MIN_TOKENS,
	estimateTokensFromBase64Payload,
	estimateTokensFromDataUrl,
	estimateTokensFromText,
	estimateTokensFromContent
} from '../modules/tokenEstimation.js';
import {
	isRateLimitOrQuotaError as isRateLimitError,
	extractRetryAfterSeconds
} from '../modules/errorClassification.js';
import {
	getCachedTiers,
	getFallbackUserTierId,
	loadTiers,
} from '../modules/tierManager.js';

dotenv.config();

const openaiRouter = new HyperExpress.Router();

// --- Rate Limiting Store ---
const requestTimestamps: RequestTimestampStore = {};
const INTERACTIONS_TOKEN_TTL_SECONDS = 15 * 60;
const rateLimitMiddleware = createRateLimitMiddleware(requestTimestamps);
const CHAT_COMPLETIONS_INTAKE_LABEL = 'chat-completions:intake';
const RESPONSES_INTAKE_LABEL = 'responses:intake';
const RESPONSES_COMPACT_INTAKE_LABEL = 'responses-compact:intake';
const AZURE_CHAT_COMPLETIONS_INTAKE_LABEL = 'azure-chat-completions:intake';

function sendOpenAiPlanModelDenied(
	response: Response,
	modelId: string,
	tierLimits?: TierData
) {
	const details = buildModelAccessError(modelId, tierLimits);
	return response.status(details.statusCode).json({
		error: {
			message: details.message,
			type: details.type,
			code: details.code,
			plan_model_access_mode: details.plan_model_access_mode,
			allowed_models: details.allowed_models,
			blocked_models: details.blocked_models
		},
		timestamp: new Date().toISOString()
	});
}

function writeResponsesSseEvent(
	response: Response,
	payload: Record<string, any>
): void {
	response.write(`event: ${payload.type}\n`);
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeStreamingErrorAndClose(
	response: Response,
	options: {
		message: string;
		statusCode?: number;
		code?: string;
		reference?: string;
		timestamp?: string;
	}
): void {
	if (response.completed) return;

	const statusCode =
		typeof options.statusCode === 'number' ? options.statusCode : 500;
	const errorType =
		statusCode === 429
			? 'rate_limit_error'
			: statusCode >= 500
				? 'server_error'
				: 'invalid_request_error';
	const payload: Record<string, any> = {
		error: {
			message:
				typeof options.message === 'string' && options.message.trim()
					? options.message
					: 'An error occurred during streaming.',
			type: errorType
		}
	};
	if (typeof options.code === 'string' && options.code.trim()) {
		payload.error.code = options.code.trim();
	}
	if (typeof options.reference === 'string' && options.reference.trim()) {
		payload.reference = options.reference.trim();
	}
	if (typeof options.timestamp === 'string' && options.timestamp.trim()) {
		payload.timestamp = options.timestamp.trim();
	}

	try {
		response.write(`event: error\n`);
		response.write(`data: ${JSON.stringify(payload)}\n\n`);
		response.write(`data: [DONE]\n\n`);
	} finally {
		if (!response.completed) response.end();
	}
}

function encodeEmbeddingBase64(values: number[]): string {
	const buffer = Buffer.alloc(values.length * 4);
	for (let index = 0; index < values.length; index += 1) {
		buffer.writeFloatLE(values[index] ?? 0, index * 4);
	}
	return buffer.toString('base64');
}

function formatEmbeddingVector(
	values: number[],
	encodingFormat?: string
): number[] | string {
	const normalizedEncoding =
		typeof encodingFormat === 'string'
			? encodingFormat.trim().toLowerCase()
			: 'float';
	if (normalizedEncoding === 'base64') {
		return encodeEmbeddingBase64(values);
	}
	return values;
}

function buildOpenAIEmbeddingResponse(
	model: string,
	vectors: number[][],
	tokensUsed: number,
	encodingFormat?: string
): Record<string, any> {
	return {
		object: 'list',
		data: vectors.map((values, index) => ({
			object: 'embedding',
			embedding: formatEmbeddingVector(values, encodingFormat),
			index
		})),
		model,
		usage: {
			prompt_tokens: tokensUsed,
			total_tokens: tokensUsed
		}
	};
}

function toGeminiEmbeddingModelPath(model: string): string {
	return model.startsWith('models/') ? model : `models/${model}`;
}

function normalizeGeminiEmbeddingInput(input: unknown): string[] | null {
	if (typeof input === 'string') return [input];
	if (!Array.isArray(input)) return null;
	const values: string[] = [];
	for (const entry of input) {
		if (typeof entry !== 'string') return null;
		values.push(entry);
	}
	return values;
}

function normalizeToolCallsForStream(
	toolCalls: any[] | undefined
): any[] | undefined {
	if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
	return toolCalls.map((call: any, index: number) => {
		const normalizedCall =
			call && typeof call === 'object'
				? { ...call }
				: { type: 'function' };
		normalizedCall.index =
			typeof normalizedCall.index === 'number'
				? normalizedCall.index
				: index;
		if (
			normalizedCall.function &&
			typeof normalizedCall.function === 'object'
		) {
			normalizedCall.function = {
				...normalizedCall.function,
				arguments:
					typeof normalizedCall.function.arguments === 'string'
						? normalizedCall.function.arguments
						: JSON.stringify(
								normalizedCall.function.arguments ?? {}
							)
			};
		}
		return normalizedCall;
	});
}

async function parseChatCompletionsRequestBody(
	request: Request,
	response: Response
): Promise<any | null> {
	return withBufferedRequestBody(
		request,
		{
			label: CHAT_COMPLETIONS_INTAKE_LABEL,
			extra: { route: '/v1/chat/completions' }
		},
		async rawBuffer => {
			try {
				return JSON.parse(rawBuffer.toString('utf8'));
			} catch (parseError) {
				const contentType = String(
					request.headers['content-type'] || ''
				);
				if (contentType.includes('multipart/form-data')) {
					const boundary = contentType.split('boundary=')[1]?.trim();
					if (boundary) {
						const parsed = parseMultipartBody(rawBuffer, boundary);

						const requestBody: Record<string, any> = {};
						if (parsed.fields.model)
							requestBody.model = parsed.fields.model;
						if (parsed.fields.messages) {
							try {
								requestBody.messages = JSON.parse(
									parsed.fields.messages
								);
							} catch {}
						}
						if (parsed.fields.stream)
							requestBody.stream =
								parsed.fields.stream === 'true';

						if (
							parsed.files.length > 0 &&
							Array.isArray(requestBody.messages)
						) {
							const lastMsg =
								requestBody.messages[
									requestBody.messages.length - 1
								];
							if (lastMsg && lastMsg.role === 'user') {
								if (typeof lastMsg.content === 'string') {
									lastMsg.content = [
										{ type: 'text', text: lastMsg.content }
									];
								}
								if (Array.isArray(lastMsg.content)) {
									parsed.files.forEach(file => {
										const base64Data =
											file.data.toString('base64');
										console.log(
											`[Multipart] Injecting image. Type: ${file.type}, Size: ${file.data.length}`
										);
										lastMsg.content.push({
											type: 'image_url',
											image_url: {
												url: `data:${file.type};base64,${base64Data}`
											}
										});
									});
								}
							}
						}
						if (!requestBody.model) {
							if (!response.completed) {
								response.status(400).json({
									error: 'Bad Request: Model field is required for multipart uploads.',
									timestamp: new Date().toISOString()
								});
							}
							return null;
						}
						if (!requestBody.messages) {
							requestBody.messages = [
								{ role: 'user', content: 'Image uploaded' }
							];
						}
						return requestBody;
					}
				}

				console.log(`[RawFallback] Buffer size: ${rawBuffer.length}`);
				if (rawBuffer.length <= 10) {
					throw parseError;
				}

				const firstChar = rawBuffer[0];
				if (firstChar === 123 || firstChar === 91) {
					throw parseError;
				}

				const isBase64 = isLikelyBase64(rawBuffer);
				let mimeType = 'image/jpeg';
				let base64Data = '';
				const utf8Text = rawBuffer.toString('utf8');

				if (utf8Text.startsWith('data:image')) {
					console.log('[RawFallback] Detected Data URI body.');
					const commaIdx = utf8Text.indexOf(',');
					if (commaIdx !== -1) {
						base64Data = utf8Text
							.slice(commaIdx + 1)
							.replace(/\s+/g, '');
						const detectedMime =
							detectMimeTypeFromBase64(base64Data);

						if (detectedMime) {
							mimeType = detectedMime;
						} else {
							const prefix = utf8Text.slice(0, commaIdx);
							const mimeMatch = prefix.match(/data:([^;]+)/);
							mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
						}
					}
				} else if (isBase64) {
					console.log('[RawFallback] Detected Base64 text body.');
					try {
						base64Data = Buffer.from(utf8Text, 'base64').toString(
							'base64'
						);
					} catch {
						base64Data = utf8Text.replace(/\s+/g, '');
					}
					mimeType =
						detectMimeTypeFromBase64(base64Data) || 'image/jpeg';
				} else {
					console.log('[RawFallback] Detected Binary body.');
					base64Data = rawBuffer.toString('base64');
					mimeType =
						detectMimeTypeFromBuffer(rawBuffer) || 'image/jpeg';
				}

				console.log(
					`[RawFallback] Type: ${mimeType}, Base64Len: ${base64Data.length}`
				);

				const queryModel =
					request.query &&
					typeof request.query.model === 'string' &&
					request.query.model
						? request.query.model
						: null;

				if (!queryModel) {
					if (!response.completed) {
						response.status(400).json({
							error: 'Bad Request: Model parameter is required for raw uploads.',
							timestamp: new Date().toISOString()
						});
					}
					return null;
				}

				return {
					model: queryModel,
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: 'Analyze this image.' },
								{
									type: 'image_url',
									image_url: {
										url: `data:${mimeType};base64,${base64Data}`
									}
								}
							]
						}
					]
				};
			}
		}
	);
}

function normalizeResponsesInputValue(rawInput: any): any[] {
	if (Array.isArray(rawInput)) {
		return rawInput;
	}
	if (typeof rawInput === 'string') {
		return [{ type: 'input_text', text: rawInput }];
	}
	if (rawInput && typeof rawInput === 'object') {
		return [rawInput];
	}
	throw new Error('input must be a string, array, or object.');
}

function extractResponsesRequestBody(requestBody: any): {
	message: IMessage;
	modelId: string;
	stream: boolean;
} {
	if (!requestBody || typeof requestBody !== 'object') {
		throw new Error('Invalid request body.');
	}

	if (
		requestBody.reasoning === undefined &&
		requestBody.reasoning_effort !== undefined
	) {
		requestBody.reasoning = requestBody.reasoning_effort;
	}

	if (
		!requestBody.model ||
		typeof requestBody.model !== 'string' ||
		!requestBody.model.trim()
	) {
		throw new Error('model parameter is required.');
	}
	const modelId = requestBody.model.trim();

	const rawInput = requestBody.input;
	if (rawInput === undefined || rawInput === null) {
		throw new Error('input is required for the responses API.');
	}

	const normalizedInput = normalizeResponsesInputValue(rawInput);

	const maxTokens =
		typeof requestBody.max_tokens === 'number'
			? requestBody.max_tokens
			: undefined;
	const maxOutputTokens =
		typeof requestBody.max_output_tokens === 'number'
			? requestBody.max_output_tokens
			: undefined;
	const temperature =
		typeof requestBody.temperature === 'number'
			? requestBody.temperature
			: undefined;
	const topP =
		typeof requestBody.top_p === 'number' ? requestBody.top_p : undefined;
	const previousResponseId =
		typeof requestBody.previous_response_id === 'string' &&
		requestBody.previous_response_id.trim()
			? requestBody.previous_response_id.trim()
			: undefined;

	const message: IMessage = {
		content: normalizedInput,
		model: { id: modelId },
		useResponsesApi: true,
		system: requestBody.system,
		response_format: requestBody.response_format,
		max_tokens: maxTokens,
		max_output_tokens: maxOutputTokens,
		temperature,
		top_p: topP,
		metadata: requestBody.metadata,
		modalities: requestBody.modalities,
		audio: requestBody.audio,
		tools: requestBody.tools,
		tool_choice: requestBody.tool_choice,
		reasoning: requestBody.reasoning,
		instructions: requestBody.instructions,
		previous_response_id: previousResponseId,
		stream_options:
			requestBody.stream_options &&
			typeof requestBody.stream_options === 'object'
				? requestBody.stream_options
				: undefined
	};

	return { message, modelId, stream: Boolean(requestBody.stream) };
}

// Token estimation constants now imported from '../modules/tokenEstimation.js'
const LOG_SENSITIVE_PAYLOADS = readEnvBool('LOG_SENSITIVE_PAYLOADS', false);
if (LOG_SENSITIVE_PAYLOADS) {
	console.warn(
		'[Security] LOG_SENSITIVE_PAYLOADS is enabled. Disable in production to avoid logging sensitive data.'
	);
}

function getBaselineTierRps(): number {
	const values = Object.values(getCachedTiers() as Record<string, any>)
		.map(tier => Number(tier?.rps))
		.filter(value => Number.isFinite(value) && value > 0);
	if (values.length === 0) return 20;
	return Math.floor(Math.min(...values));
}

const BASELINE_TIER_RPS = getBaselineTierRps();
const UPSTREAM_TIMEOUT_MS = readEnvNumber('UPSTREAM_TIMEOUT_MS', 120_000);
const EMBEDDINGS_QUEUE_CONCURRENCY = Math.max(
	1,
	readEnvNumber(
		'EMBEDDINGS_QUEUE_CONCURRENCY',
		Math.max(1, Math.min(8, Math.floor(BASELINE_TIER_RPS / 10)))
	)
);
const EMBEDDINGS_QUEUE_MAX_PENDING = Math.max(
	0,
	readEnvNumber(
		'EMBEDDINGS_QUEUE_MAX_PENDING',
		Math.max(8, Math.min(64, BASELINE_TIER_RPS))
	)
);
const VIDEO_REQUEST_CACHE_TTL_MS = resolveVideoRequestCacheTtlMs(
	process.env.VIDEO_REQUEST_CACHE_TTL_MS
);
const VIDEO_ASYNC_RETRY_MAX_ATTEMPTS = Math.max(
	1,
	readEnvNumber('VIDEO_ASYNC_RETRY_MAX_ATTEMPTS', 3)
);
const IMAGE_FETCH_TIMEOUT_MS = readEnvNumber('IMAGE_FETCH_TIMEOUT_MS', 15_000);
const IMAGE_FETCH_MAX_BYTES = readEnvNumber(
	'IMAGE_FETCH_MAX_BYTES',
	8 * 1024 * 1024
);
const IMAGE_FETCH_MAX_REDIRECTS = readEnvNumber('IMAGE_FETCH_MAX_REDIRECTS', 3);
const IMAGE_FETCH_ALLOW_PRIVATE = readEnvBool(
	'IMAGE_FETCH_ALLOW_PRIVATE',
	false
);
const IMAGE_FETCH_FORWARD_AUTH = readEnvBool('IMAGE_FETCH_FORWARD_AUTH', false);
const IMAGE_FETCH_USER_AGENT =
	process.env.IMAGE_FETCH_USER_AGENT ||
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IMAGE_FETCH_REFERER = process.env.IMAGE_FETCH_REFERER;
const IMAGE_FETCH_ALLOWED_PROTOCOLS = (
	readEnvCsv('IMAGE_FETCH_ALLOWED_PROTOCOLS') ?? ['http', 'https']
).map(p => p.toLowerCase());
const IMAGE_FETCH_ALLOWED_HOSTS = readEnvCsv('IMAGE_FETCH_ALLOWED_HOSTS');

export function getOpenAiAdmissionQueueSnapshots(): Array<
	Record<string, unknown>
> {
	return [
		{
			lane: 'shared-request-handler',
			routes: ['/v1/chat/completions', '/v1/responses'],
			shared: true,
			...requestQueue.snapshot()
		},
		{
			lane: 'embeddings',
			route: '/v1/embeddings',
			shared: false,
			...embeddingsQueue.snapshot()
		}
	];
}

const embeddingsQueue = new RequestQueue(EMBEDDINGS_QUEUE_CONCURRENCY, {
	label: 'embeddings-admission',
	maxPending: EMBEDDINGS_QUEUE_MAX_PENDING
});

function attachQueueOverloadMetadata(
	error: unknown,
	queue: RequestQueue,
	extra: Record<string, unknown> = {}
): void {
	if (!(error instanceof QueueOverloadedError) && typeof error !== 'object')
		return;
	const target = error as Record<string, unknown>;
	const snapshot = queue.snapshot();
	target.queueLabel =
		typeof target.queueLabel === 'string' &&
		String(target.queueLabel).trim()
			? target.queueLabel
			: snapshot.label;
	target.queue = {
		label: snapshot.label,
		concurrency: snapshot.concurrency,
		maxPending: snapshot.maxPending,
		inFlight: snapshot.inFlight,
		pending: snapshot.pending,
		overloadCount: snapshot.overloadCount,
		lastOverloadedAt: snapshot.lastOverloadedAt,
		...extra
	};
}

// readEnvNumber, readEnvBool, readEnvCsv now imported from '../modules/tokenEstimation.js'

type VideoRequestCacheEntry = VideoRequestCacheProvider & {
	expiresAt: number;
};

const videoRequestCache = new Map<string, VideoRequestCacheEntry>();
const VIDEO_CACHE_EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const VIDEO_REQUEST_CACHE_REDIS_KEY_PREFIX = 'api:video-request-cache:';

// Periodic eviction to prevent unbounded Map growth
const _videoCacheEvictionTimer = setInterval(() => {
	const now = Date.now();
	let evicted = 0;
	for (const [key, entry] of videoRequestCache) {
		if (entry.expiresAt < now) {
			videoRequestCache.delete(key);
			evicted++;
		}
	}
	if (evicted > 0) {
		console.log(
			`[VideoCacheEviction] Swept ${evicted} expired entries. Remaining: ${videoRequestCache.size}`
		);
	}
}, VIDEO_CACHE_EVICTION_INTERVAL_MS);
if (typeof (_videoCacheEvictionTimer as any).unref === 'function')
	(_videoCacheEvictionTimer as any).unref();

function getVideoRequestCacheRedisKey(requestId: string): string {
	return `${VIDEO_REQUEST_CACHE_REDIS_KEY_PREFIX}${String(requestId || '').trim()}`;
}

function normalizePositiveWholeNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return undefined;
}

function buildVideoProviderSignature(provider: {
	apiKey: string;
	baseUrl: string;
}): string {
	return `${provider.baseUrl}\u0000${provider.apiKey}`;
}

function dedupeVideoRetryProviders(
	providers: Array<{ apiKey: string; baseUrl: string }>
): Array<{ apiKey: string; baseUrl: string }> {
	const seen = new Set<string>();
	const next: Array<{ apiKey: string; baseUrl: string }> = [];
	for (const provider of providers) {
		if (!provider?.apiKey || !provider?.baseUrl) continue;
		const signature = buildVideoProviderSignature(provider);
		if (seen.has(signature)) continue;
		seen.add(signature);
		next.push({
			apiKey: provider.apiKey,
			baseUrl: provider.baseUrl
		});
	}
	return next;
}

function normalizeVideoRetryState(
	value: unknown
): VideoRequestCacheProvider['retryState'] | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, any>;
	const modelId =
		typeof record.modelId === 'string' && record.modelId.trim()
			? record.modelId.trim()
			: '';
	const prompt = typeof record.prompt === 'string' ? record.prompt : '';
	if (!modelId || !prompt) return undefined;

	const imageUrl =
		record.imageUrl === null
			? null
			: typeof record.imageUrl === 'string' && record.imageUrl.trim()
				? record.imageUrl.trim()
				: undefined;
	const attemptCount = normalizePositiveWholeNumber(record.attemptCount);
	const maxAttempts = normalizePositiveWholeNumber(record.maxAttempts);
	const attemptedProviders = Array.isArray(record.attemptedProviders)
		? dedupeVideoRetryProviders(
				record.attemptedProviders
					.filter(
						(item: any) =>
							item &&
							typeof item === 'object' &&
							typeof item.apiKey === 'string' &&
							typeof item.baseUrl === 'string'
					)
					.map((item: any) => ({
						apiKey: item.apiKey.trim(),
						baseUrl: item.baseUrl.trim()
					}))
		  )
		: undefined;

	return {
		modelId,
		prompt,
		...(imageUrl !== undefined ? { imageUrl } : {}),
		...(record.requestBody !== undefined ? { requestBody: record.requestBody } : {}),
		...(attemptCount ? { attemptCount } : {}),
		...(maxAttempts ? { maxAttempts } : {}),
		...(attemptedProviders && attemptedProviders.length > 0
			? { attemptedProviders }
			: {})
	};
}

function resolveVideoLookupRequestId(
	requestId: string,
	provider: VideoRequestCacheProvider | null | undefined
): string {
	const activeRequestId =
		typeof provider?.activeRequestId === 'string' &&
		provider.activeRequestId.trim()
			? provider.activeRequestId.trim()
			: '';
	return activeRequestId || requestId;
}

function shouldRetryFailedVideoStatus(resJson: any): boolean {
	if (String(resJson?.status || '').trim().toLowerCase() !== 'failed') {
		return false;
	}
	const code = String(resJson?.error?.code || '').trim().toLowerCase();
	const type = String(resJson?.error?.type || '').trim().toLowerCase();
	const message = String(resJson?.error?.message || resJson?.message || '')
		.trim()
		.toLowerCase();

	const nonRetryableCodes = new Set([
		'moderation_blocked',
		'content_policy_violation',
		'invalid_request_error',
		'invalid_type',
		'unknown_parameter'
	]);
	if (nonRetryableCodes.has(code) || nonRetryableCodes.has(type)) {
		return false;
	}

	const nonRetryableFragments = [
		'moderation',
		'blocked by our moderation system',
		'content policy',
		'safety system',
		'invalid request',
		'unknown parameter',
		'invalid type',
		'must match the requested width and height',
		'file_id',
		'image_url',
		'input_reference',
		'not available on your current plan',
		'copyright'
	];
	return !nonRetryableFragments.some(fragment => message.includes(fragment));
}

function setVideoRequestCacheLocal(
	requestId: string,
	provider: VideoRequestCacheProvider,
	ttlMs: number = provider.ttlMs ?? VIDEO_REQUEST_CACHE_TTL_MS
) {
	if (!requestId) return;
	const expiresAt = Date.now() + Math.max(1, ttlMs);
	videoRequestCache.set(requestId, { ...provider, expiresAt });
}

function deleteVideoRequestCacheLocal(requestId: string) {
	if (!requestId) return;
	videoRequestCache.delete(requestId);
}

function getVideoRequestCacheLocal(
	requestId: string
): VideoRequestCacheProvider | null {
	const entry = videoRequestCache.get(requestId);
	if (!entry) return null;
	if (entry.expiresAt < Date.now()) {
		videoRequestCache.delete(requestId);
		return null;
	}
	return {
		apiKey: entry.apiKey,
		baseUrl: entry.baseUrl,
		...(entry.kind ? { kind: entry.kind } : {}),
		...(entry.operationName ? { operationName: entry.operationName } : {}),
		...(entry.modelId ? { modelId: entry.modelId } : {}),
		...(entry.contentUri ? { contentUri: entry.contentUri } : {}),
		...(entry.activeRequestId
			? { activeRequestId: entry.activeRequestId }
			: {}),
		...(entry.retryState ? { retryState: entry.retryState } : {})
	};
}

async function setVideoRequestCache(
	requestId: string,
	provider: VideoRequestCacheProvider
): Promise<void> {
	if (!requestId) return;
	const normalizedRequestId = String(requestId).trim();
	setVideoRequestCacheLocal(normalizedRequestId, provider);
	if (!redis || redis.status !== 'ready') return;

	try {
		await redis.set(
			getVideoRequestCacheRedisKey(normalizedRequestId),
			JSON.stringify({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
				kind: provider.kind,
				operationName: provider.operationName,
				modelId: provider.modelId,
				contentUri: provider.contentUri,
				activeRequestId: provider.activeRequestId,
				retryState: provider.retryState
			}),
			'PX',
			Math.max(1, provider.ttlMs ?? VIDEO_REQUEST_CACHE_TTL_MS)
		);
	} catch (error: any) {
		console.warn(
			`[VideoRequestCache] Failed to persist ${normalizedRequestId}: ${
				error?.message || error
			}`
		);
	}
}

async function deleteVideoRequestCache(requestId: string): Promise<void> {
	if (!requestId) return;
	const normalizedRequestId = String(requestId).trim();
	deleteVideoRequestCacheLocal(normalizedRequestId);
	if (!redis || redis.status !== 'ready') return;

	try {
		await redis.del(getVideoRequestCacheRedisKey(normalizedRequestId));
	} catch (error: any) {
		console.warn(
			`[VideoRequestCache] Failed to delete ${normalizedRequestId}: ${
				error?.message || error
			}`
		);
	}
}

async function getVideoRequestCache(
	requestId: string
): Promise<VideoRequestCacheProvider | null> {
	if (!requestId) return null;
	const normalizedRequestId = String(requestId).trim();
	const local = getVideoRequestCacheLocal(normalizedRequestId);
	if (local) return local;
	if (!redis || redis.status !== 'ready') return null;

	try {
		const redisKey = getVideoRequestCacheRedisKey(normalizedRequestId);
		const raw = await redis.get(redisKey);
		if (!raw) return null;

		const parsed = JSON.parse(raw) as {
			apiKey?: unknown;
			baseUrl?: unknown;
			kind?: unknown;
			operationName?: unknown;
			modelId?: unknown;
			contentUri?: unknown;
			activeRequestId?: unknown;
			retryState?: unknown;
		};
		const apiKey =
			typeof parsed?.apiKey === 'string' && parsed.apiKey.trim()
				? parsed.apiKey.trim()
				: '';
		const baseUrl =
			typeof parsed?.baseUrl === 'string' && parsed.baseUrl.trim()
				? parsed.baseUrl.trim()
				: '';
		if (!apiKey || !baseUrl) return null;
		const kind =
			typeof parsed?.kind === 'string' && parsed.kind.trim()
				? parsed.kind.trim()
				: undefined;
		const operationName =
			typeof parsed?.operationName === 'string' &&
			parsed.operationName.trim()
				? parsed.operationName.trim()
				: undefined;
		const modelId =
			typeof parsed?.modelId === 'string' && parsed.modelId.trim()
				? parsed.modelId.trim()
				: undefined;
		const contentUri =
			typeof parsed?.contentUri === 'string' && parsed.contentUri.trim()
				? parsed.contentUri.trim()
				: undefined;
		const activeRequestId =
			typeof parsed?.activeRequestId === 'string' &&
			parsed.activeRequestId.trim()
				? parsed.activeRequestId.trim()
				: undefined;
		const retryState = normalizeVideoRetryState(parsed?.retryState);

		let ttlMs = VIDEO_REQUEST_CACHE_TTL_MS;
		try {
			const redisTtlMs = await redis.pttl(redisKey);
			if (Number.isFinite(redisTtlMs) && redisTtlMs > 0) {
				ttlMs = redisTtlMs;
			}
		} catch {
			// Ignore TTL refresh failures; the default TTL is sufficient for local cache hydration.
		}

		const hydrated: VideoRequestCacheProvider = {
			apiKey,
			baseUrl,
			...(kind ? { kind: kind as VideoRequestCacheProvider['kind'] } : {}),
			...(operationName ? { operationName } : {}),
			...(modelId ? { modelId } : {}),
			...(contentUri ? { contentUri } : {}),
			...(activeRequestId ? { activeRequestId } : {}),
			...(retryState ? { retryState } : {})
		};
		setVideoRequestCacheLocal(normalizedRequestId, hydrated, ttlMs);
		return hydrated;
	} catch (error: any) {
		console.warn(
			`[VideoRequestCache] Failed to load ${normalizedRequestId}: ${
				error?.message || error
			}`
		);
		return null;
	}
}

async function attemptFailedVideoRetry(params: {
	request: Request;
	requestedRequestId: string;
	failedRequestId: string;
	failedResponse: any;
	cachedProvider: VideoRequestCacheProvider;
}): Promise<Record<string, any> | null> {
	const {
		request,
		requestedRequestId,
		failedRequestId,
		failedResponse,
		cachedProvider
	} = params;
	const retryState = cachedProvider.retryState;
	if (!retryState || !shouldRetryFailedVideoStatus(failedResponse)) {
		return null;
	}

	const attemptCount = Math.max(
		1,
		normalizePositiveWholeNumber(retryState.attemptCount) || 1
	);
	const maxAttempts = Math.max(
		1,
		normalizePositiveWholeNumber(retryState.maxAttempts) ||
			VIDEO_ASYNC_RETRY_MAX_ATTEMPTS
	);
	if (attemptCount >= maxAttempts) {
		return null;
	}

	const excludedProviders = dedupeVideoRetryProviders([
		...(retryState.attemptedProviders || []),
		{
			apiKey: cachedProvider.apiKey,
			baseUrl: cachedProvider.baseUrl
		}
	]);

	try {
		const retryResult = await requestVideoGeneration({
			modelId: retryState.modelId,
			prompt: retryState.prompt,
			imageUrl:
				retryState.imageUrl === undefined ? null : retryState.imageUrl,
			requestBody: retryState.requestBody ?? {},
			upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
			excludeProviders: excludedProviders
		});

		const nextRetryState = {
			...retryState,
			attemptCount: attemptCount + 1,
			maxAttempts,
			attemptedProviders: dedupeVideoRetryProviders([
				...excludedProviders,
				{
					apiKey: retryResult.provider.apiKey,
					baseUrl: retryResult.provider.baseUrl
				}
			])
		};
		const nextProvider = buildVideoRequestCacheProvider(
			{
				...retryResult.provider,
				activeRequestId: retryResult.requestId,
				retryState: nextRetryState
			},
			retryResult.responseJson,
			VIDEO_REQUEST_CACHE_TTL_MS
		);
		const cacheTargets = Array.from(
			new Set(
				[requestedRequestId, failedRequestId, retryResult.requestId].filter(
					(value): value is string =>
						typeof value === 'string' && value.trim().length > 0
				)
			)
		);
		await Promise.allSettled(
			cacheTargets.map((cacheRequestId: string) =>
				setVideoRequestCache(cacheRequestId, nextProvider)
			)
		);

		return {
			...retryResult.responseJson,
			original_request_id: requestedRequestId,
			retried_from_request_id: failedRequestId,
			retry_count: Math.max(
				0,
				(normalizePositiveWholeNumber(nextRetryState.attemptCount) || 1) -
					1
			)
		};
	} catch (error: any) {
		await logError(
			{
				message: 'Video generation retry failed',
				requestedRequestId,
				failedRequestId,
				errorMessage: error?.message || String(error),
				errorStack: error?.stack
			},
			request
		);
		return null;
	}
}

const RESERVED_VIDEO_ROUTE_SEGMENTS = new Set([
	'characters',
	'edits',
	'extensions',
	'generations'
]);

function isReservedVideoRouteSegment(segment: string): boolean {
	return RESERVED_VIDEO_ROUTE_SEGMENTS.has(
		String(segment || '').trim().toLowerCase()
	);
}

function sendReservedVideoRouteMethodHint(
	response: Response,
	method: string,
	segment: string
): void {
	const normalizedMethod =
		String(method || 'GET').trim().toUpperCase() || 'GET';
	const normalizedSegment = String(segment || '').trim().toLowerCase();

	let guidance =
		'Use POST /v1/videos to create a video job. GET /v1/videos lists jobs, and GET /v1/videos/{video_id} retrieves a specific job once you have a real video id.';
	if (normalizedSegment === 'generations') {
		guidance =
			'Use POST /v1/videos to create a video job. POST /v1/videos/generations is still accepted as a legacy alias. GET /v1/videos lists jobs, and GET /v1/videos/{video_id} retrieves a specific job once you have a real video id.';
	} else if (normalizedSegment === 'edits') {
		guidance =
			'Use POST /v1/videos/edits to edit a video. GET /v1/videos lists jobs, and GET /v1/videos/{video_id} retrieves a specific job once you have a real video id.';
	} else if (normalizedSegment === 'extensions') {
		guidance =
			'Use POST /v1/videos/extensions to extend a video. GET /v1/videos lists jobs, and GET /v1/videos/{video_id} retrieves a specific job once you have a real video id.';
	} else if (normalizedSegment === 'characters') {
		guidance =
			'Use POST /v1/videos/characters to create a character, or GET /v1/videos/characters/{character_id} to retrieve one. GET /v1/videos/{video_id} is only for actual video ids.';
	}

	response.setHeader('Allow', 'POST');
	response.status(405).json({
		error: {
			message: `Invalid ${normalizedMethod} /v1/videos/${normalizedSegment}. ${guidance}`,
			type: 'invalid_request_error',
			param: 'path',
			code: 'method_not_allowed'
		},
		timestamp: new Date().toISOString()
	});
}

type ParsedVideoForwardBody = {
	contentType: string;
	body: BodyInit;
	jsonBody?: any;
	multipart?: ReturnType<typeof parseMultipartBody>;
};

function buildForwardedQueryString(
	rawQuery: Record<string, any> | undefined
): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(rawQuery || {})) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (
					item !== undefined &&
					item !== null &&
					typeof item !== 'object'
				) {
					params.append(key, String(item));
				}
			}
			continue;
		}
		if (typeof value !== 'object') {
			params.append(key, String(value));
		}
	}
	const query = params.toString();
	return query ? `?${query}` : '';
}

function dedupeVideoProviders(
	providers: Array<{ apiKey: string; baseUrl: string }>
): Array<{ apiKey: string; baseUrl: string }> {
	const seen = new Set<string>();
	const next: Array<{ apiKey: string; baseUrl: string }> = [];
	for (const provider of providers) {
		const signature = `${provider.baseUrl}\u0000${provider.apiKey}`;
		if (seen.has(signature)) continue;
		seen.add(signature);
		next.push(provider);
	}
	return next;
}

function inferVideoProviderKindFromRequestId(
	requestId: string
): 'openai' | 'xai' | null {
	const normalized = String(requestId || '').trim();
	if (!normalized) return null;
	if (/^video[_-][a-z0-9]/i.test(normalized)) return 'openai';
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			normalized
		)
	) {
		return 'xai';
	}
	return null;
}

function isGeminiVideoCacheProvider(
	provider: VideoRequestCacheProvider | null | undefined
): provider is VideoRequestCacheProvider & {
	kind: 'gemini';
	operationName: string;
} {
	return (
		Boolean(provider) &&
		provider?.kind === 'gemini' &&
		typeof provider.operationName === 'string' &&
		provider.operationName.trim().length > 0
	);
}

async function getOpenAIVideoProvidersToTry(
	options: { resourceId?: string; modelId?: string } = {}
): Promise<Array<{ apiKey: string; baseUrl: string }>> {
	const next: Array<{ apiKey: string; baseUrl: string }> = [];
	if (options.resourceId) {
		const cached = await getVideoRequestCache(options.resourceId);
		if (isGeminiVideoCacheProvider(cached)) {
			return [];
		}
		if (cached) next.push(cached);
	}
	if (options.modelId) {
		const availableModelProviders = await listVideoGenProviders(
			options.modelId
		);
		if (
			availableModelProviders.length > 0 &&
			availableModelProviders.every(
				provider => provider.kind === 'gemini'
			)
		) {
			return [];
		}
		const modelProviders = availableModelProviders
			.filter(provider => provider.kind === 'openai')
			.map(provider => ({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl
			}));
		next.push(...modelProviders);
	}
	const fallbackProviders = (await listAnyVideoProviders())
		.filter(provider => provider.kind === 'openai')
		.map(provider => ({
			apiKey: provider.apiKey,
			baseUrl: provider.baseUrl
		}));
	next.push(...fallbackProviders);
	return dedupeVideoProviders(next);
}

async function forwardVideoRequestToProviders(params: {
	providersToTry: Array<{ apiKey: string; baseUrl: string }>;
	pathname: string;
	method: 'GET' | 'POST' | 'DELETE';
	upstreamTimeoutMs: number;
	body?: BodyInit;
	contentType?: string;
	rawQuery?: Record<string, any>;
	label: string;
	retryableStatusCodes?: number[];
}): Promise<{
	provider: { apiKey: string; baseUrl: string };
	upstreamRes: globalThis.Response;
}> {
	const {
		providersToTry,
		pathname,
		method,
		upstreamTimeoutMs,
		body,
		contentType,
		rawQuery,
		label
	} = params;
	const retryableStatusCodes = params.retryableStatusCodes || [
		401, 402, 403, 404, 405, 408, 409, 423, 425, 429, 500, 501, 502, 503,
		504
	];
	if (providersToTry.length === 0) {
		const error = new Error(
			`No available provider for ${label.toLowerCase()}`
		);
		(error as any).statusCode = 503;
		throw error;
	}

	const forwardedQuery = buildForwardedQueryString(rawQuery);
	let lastStatus = 503;
	let lastErrorText = `No available provider for ${label.toLowerCase()}`;
	for (const provider of providersToTry) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${provider.apiKey}`
		};
		if (contentType) headers['Content-Type'] = contentType;
		const upstreamUrl = `${provider.baseUrl}/v1${pathname}${forwardedQuery}`;
		const upstreamRes = await fetchWithTimeout(
			upstreamUrl,
			{
				method,
				headers,
				body
			},
			upstreamTimeoutMs
		);

		if (upstreamRes.ok) {
			return { provider, upstreamRes };
		}

		lastStatus = upstreamRes.status;
		lastErrorText = await upstreamRes
			.text()
			.catch(() => upstreamRes.statusText || lastErrorText);
		if (!retryableStatusCodes.includes(upstreamRes.status)) {
			break;
		}
	}

	const error = new Error(`${label} upstream error: ${lastErrorText}`);
	(error as any).statusCode = lastStatus;
	throw error;
}

async function parseVideoForwardBody(
	request: Request,
	options: { multipartOnly?: boolean } = {}
): Promise<ParsedVideoForwardBody> {
	const contentType = String(request.headers['content-type'] || '');
	if (contentType.includes('multipart/form-data')) {
		const rawBody = await request.buffer();
		const boundary = contentType.split('boundary=')[1]?.trim();
		if (!boundary) {
			const error = new Error('Bad Request: boundary missing');
			(error as any).statusCode = 400;
			throw error;
		}
		return {
			contentType,
			body: rawBody as any,
			multipart: parseMultipartBody(rawBody, boundary)
		};
	}

	if (options.multipartOnly) {
		const error = new Error('Bad Request: multipart/form-data required');
		(error as any).statusCode = 400;
		throw error;
	}

	let jsonBody: any;
	try {
		jsonBody = await request.json();
	} catch {
		const error = new Error(
			'Bad Request: application/json or multipart/form-data required'
		);
		(error as any).statusCode = 400;
		throw error;
	}

	return {
		contentType: 'application/json',
		body: JSON.stringify(jsonBody),
		jsonBody
	};
}

function extractParsedVideoField(
	parsedBody: ParsedVideoForwardBody,
	fieldName: string
): string {
	if (typeof parsedBody.jsonBody?.[fieldName] === 'string') {
		return parsedBody.jsonBody[fieldName];
	}
	if (typeof parsedBody.multipart?.fields?.[fieldName] === 'string') {
		return parsedBody.multipart.fields[fieldName];
	}
	return '';
}

function parsePositiveNumericField(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function resolveImageBillingQuantity(requestBody: any): number {
	const requested = parsePositiveNumericField(requestBody?.n);
	return typeof requested === 'number' ? Math.max(1, Math.ceil(requested)) : 1;
}

function resolveVideoBillingQuantity(requestBody: any): number {
	return (
		parsePositiveNumericField(requestBody?.seconds) ??
		parsePositiveNumericField(requestBody?.duration) ??
		1
	);
}

function resolveParsedVideoBillingQuantity(
	parsedBody: ParsedVideoForwardBody
): number {
	return resolveVideoBillingQuantity(
		parsedBody.jsonBody ?? parsedBody.multipart?.fields ?? {}
	);
}

function getVideoResourceRetryableStatusCodes(
	resourceId: string | undefined
): number[] {
	if (resourceId && getVideoRequestCacheLocal(resourceId)) {
		return [
			401, 402, 403, 404, 405, 408, 409, 423, 425, 429, 500, 501, 502,
			503, 504
		];
	}
	return [
		401, 402, 403, 405, 408, 409, 423, 425, 429, 500, 501, 502, 503, 504
	];
}

// estimateTokensFromBase64Payload, estimateTokensFromDataUrl, estimateTokensFromText,
// estimateTokensFromContent now imported from '../modules/tokenEstimation.js'

// --- Routes ---

// Generate Key Route - Handler becomes async
openaiRouter.post(
	'/generate_key',
	authAndUsageMiddleware,
	rateLimitMiddleware,
	async (request: Request, response: Response) => {
		// Check if middleware failed (e.g., if it didn't attach data)
		if (!request.apiKey || request.userRole === undefined) {
			await logError(
				{
					message:
						'Authentication failed in /generate_key route after middleware'
				},
				request
			);
			if (!response.completed) {
				return response.status(401).json({
					error: 'Authentication failed',
					timestamp: new Date().toISOString()
				});
			} else {
				return;
			}
		}
		try {
			if (request.userRole !== 'admin') {
				await logError(
					{
						message: 'Forbidden: Non-admin attempt to generate key',
						userId: request.userId
					},
					request
				);
				if (!response.completed) {
					return response.status(403).json({
						error: 'Forbidden',
						timestamp: new Date().toISOString()
					});
				} else {
					return;
				}
			}
			const body = await request.json();
			const { userId, role = 'user', tier } = body || {};
			if (!userId || typeof userId !== 'string') {
				await logError(
					{
						message:
							'Bad Request: userId required for key generation'
					},
					request
				);
				if (!response.completed) {
					return response.status(400).json({
						error: 'Bad Request: userId required',
						timestamp: new Date().toISOString()
					});
				} else {
					return;
				}
			}

			const roleStr = String(role);
			if (roleStr !== 'admin' && roleStr !== 'user') {
				if (!response.completed) {
					return response.status(400).json({
						error: 'Bad Request: role must be "admin" or "user"',
						timestamp: new Date().toISOString()
					});
				} else {
					return;
				}
			}

			const tiers = await loadTiers();
			const tierStr = typeof tier === 'string' ? tier.trim() : '';
			if (tierStr && !tiers[tierStr]) {
				if (!response.completed) {
					return response.status(400).json({
						error: `Bad Request: tier '${tierStr}' not found`,
						timestamp: new Date().toISOString()
					});
				} else {
					return;
				}
			}

			const newUserApiKey = await generateUserApiKey(
				userId,
				roleStr as 'admin' | 'user',
				tierStr || undefined
			);
			const finalTier = tierStr || getFallbackUserTierId(tiers);
			response.json({
				apiKey: newUserApiKey,
				role: roleStr,
				tier: finalTier
			});
		} catch (error: any) {
			await logError(error, request);
			console.error('Generate key error:', error);
			const timestamp = new Date().toISOString();
			let status = 500;
			let msg = 'Internal Server Error';
			let ref: string | undefined = 'Failed to generate key.';
			if (error.message.includes('already has')) {
				status = 409;
				msg = error.message;
				ref = undefined;
			}
			if (error instanceof SyntaxError) {
				status = 400;
				msg = 'Invalid JSON';
				ref = undefined;
			}
			if (!response.completed) {
				const responseBody: {
					error: string;
					reference?: string;
					timestamp: string;
				} = {
					error: msg,
					timestamp
				};
				if (ref) {
					responseBody.reference = ref;
				}
				response.status(status).json(responseBody);
			} else {
				// Cannot send response, middleware already handled it or response completed.
				// No explicit return needed here if void is acceptable.
			}
		}
	}
);

// Generated image asset route.
openaiRouter.get(
	'/generated-images/:imageId',
	async (request: Request, response: Response) => {
		try {
			const imageId =
				typeof request.params?.imageId === 'string'
					? request.params.imageId
					: '';
			const asset = getCachedGeneratedImage(imageId);
			if (!asset) {
				return response.status(404).json({
					error: 'Generated image not found',
					timestamp: new Date().toISOString()
				});
			}

			response.setHeader('Content-Type', asset.mimeType);
			response.setHeader(
				'Cache-Control',
				getGeneratedImageCacheControlHeader()
			);
			response.end(asset.data);
		} catch (error: any) {
			await logError(
				{
					message: 'Generated image asset route failed',
					errorMessage: error?.message,
					imageId: request.params?.imageId
				},
				request
			);
			if (!response.completed) {
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

// Keep key-inspection routes available after quota/rate exhaustion so users can
// still see why a key stopped working and how much usage remains.
openaiRouter.get(
	'/keys/me',
	authKeyOnlyMiddleware,
	async (request: Request, response: Response) => {
		try {
			const apiKey = request.apiKey;
			if (!apiKey) {
				if (!response.completed) {
					return response.status(401).json({
						error: 'Unauthorized: Missing API key',
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			const keys = await dataManager.load<KeysFile>('keys');
			const userData = keys[apiKey];
			if (!userData) {
				if (!response.completed) {
					return response.status(401).json({
						error: 'Unauthorized: Invalid API key',
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			const liveTiers = request.tierLimits ? null : await loadTiers();
			const tierLimits =
				request.tierLimits ||
				(userData?.tier ? liveTiers?.[userData.tier] : null);
			return response.json(
				buildKeyDetailsPayload(apiKey, userData, tierLimits, 'cache')
			);
		} catch (error: any) {
			await logError(error, request);
			if (!response.completed) {
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

openaiRouter.get(
	'/keys/me/live',
	authKeyOnlyMiddleware,
	async (request: Request, response: Response) => {
		try {
			const apiKey = request.apiKey;
			if (!apiKey) {
				if (!response.completed) {
					return response.status(401).json({
						error: 'Unauthorized: Missing API key',
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			const { keys, source } = await loadKeysLiveSnapshot();
			const userData = keys[apiKey];
			if (!userData) {
				if (!response.completed) {
					return response.status(401).json({
						error: 'Unauthorized: Invalid API key',
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			const liveTiers = request.tierLimits ? null : await loadTiers();
			const tierLimits =
				request.tierLimits ||
				(userData?.tier ? liveTiers?.[userData.tier] : null);
			return response.json(
				buildKeyDetailsPayload(apiKey, userData, tierLimits, source)
			);
		} catch (error: any) {
			await logError(error, request);
			if (!response.completed) {
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

// Apply Middlewares - order matters
// Fix: Remove '/v1' prefix since the router is already mounted at '/v1' in server.ts
openaiRouter.use('/', authAndUsageMiddleware);
// Fix: Remove '/v1' prefix from the path
openaiRouter.use('/chat/completions', rateLimitMiddleware);
openaiRouter.use('/responses', rateLimitMiddleware);
openaiRouter.use('/interactions', rateLimitMiddleware);
openaiRouter.use('/audio', rateLimitMiddleware);
openaiRouter.use('/images', rateLimitMiddleware);
openaiRouter.use('/videos', rateLimitMiddleware);
openaiRouter.use('/embeddings', rateLimitMiddleware);

// Chat Completions Route - Handler is already async
openaiRouter.post(
	'/chat/completions',
	async (request: Request, response: Response) => {
		// Check if middleware failed
		if (!request.apiKey || !request.tierLimits) {
			await logError(
				{
					message:
						'Authentication or configuration failed in /v1/chat/completions after middleware'
				},
				request
			);
			if (!response.completed) {
				return response.status(401).json({
					error: 'Authentication or configuration failed',
					timestamp: new Date().toISOString()
				});
			} else {
				return;
			}
		}
		try {
			const userApiKey = request.apiKey!;
			const tierLimits = request.tierLimits!;

			let requestBody: any;
			requestBody = await parseChatCompletionsRequestBody(
				request,
				response
			);
			if (requestBody === null) return;

			const modelHint =
				typeof requestBody?.model === 'string' ? requestBody.model : '';
			if (
				(!Array.isArray(requestBody?.messages) ||
					requestBody.messages.length === 0) &&
				typeof requestBody?.prompt === 'string' &&
				isNonChatModel(modelHint) === 'image-gen'
			) {
				requestBody.messages = [
					{ role: 'user', content: requestBody.prompt }
				];
			}

			const normalizedMaxTokens =
				typeof requestBody?.max_tokens === 'number'
					? requestBody.max_tokens
					: typeof requestBody?.max_tokens === 'string'
						? Number(requestBody.max_tokens)
						: undefined;
			if (normalizedMaxTokens !== undefined) {
				const maxTokensLimit = Math.max(
					0,
					Number(process.env.MAX_MAX_TOKENS || 0) || 0
				);
				if (
					!Number.isFinite(normalizedMaxTokens) ||
					normalizedMaxTokens <= 0
				) {
					return response.status(400).json({
						error: 'Invalid max_tokens value.',
						timestamp: new Date().toISOString()
					});
				}
				if (
					maxTokensLimit > 0 &&
					normalizedMaxTokens > maxTokensLimit
				) {
					return response.status(400).json({
						error: `max_tokens exceeds limit (${maxTokensLimit}).`,
						timestamp: new Date().toISOString()
					});
				}
			}

			const result = extractMessageFromRequestBody(requestBody);
			let { messages: rawMessages, model: modelId } = result;
			rawMessages = filterValidChatMessages(rawMessages);
			if (rawMessages.length === 0) {
				if (!response.completed) {
					return response.status(400).json({
						error: {
							message:
								'Bad Request: messages must include at least one message with a role.',
							type: 'invalid_request_error',
							param: 'messages',
							code: 'invalid_messages'
						},
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			const imageFetchReferer = normalizeImageFetchReferer(
				getHeaderValue(request.headers, 'x-image-fetch-referer') ||
					getHeaderValue(request.headers, 'x-image-referer')
			);

			// Inline HTTP image URLs to base64 to avoid OpenAI fetching errors on private/local URLs
			await inlineImageUrlsShared(
				rawMessages,
				request.headers['authorization'],
				imageFetchReferer,
				{
					allowedHosts: IMAGE_FETCH_ALLOWED_HOSTS,
					allowedProtocols: IMAGE_FETCH_ALLOWED_PROTOCOLS,
					allowPrivate: IMAGE_FETCH_ALLOW_PRIVATE,
					forwardAuth: IMAGE_FETCH_FORWARD_AUTH,
					userAgent: IMAGE_FETCH_USER_AGENT,
					referer: IMAGE_FETCH_REFERER,
					timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
					maxRedirects: IMAGE_FETCH_MAX_REDIRECTS,
					maxBytes: IMAGE_FETCH_MAX_BYTES,
					logSensitivePayloads: LOG_SENSITIVE_PAYLOADS
				}
			);

			// Sanitize image URLs in messages (strip whitespace and normalize base64 to standard format)
			if (rawMessages && Array.isArray(rawMessages)) {
				rawMessages.forEach(msg => {
					if (Array.isArray(msg.content)) {
						msg.content.forEach((part: any) => {
							if (
								part &&
								part.type === 'image_url' &&
								typeof part.image_url?.url === 'string'
							) {
								if (part.image_url.url.startsWith('data:')) {
									const dataUri = part.image_url.url;
									const commaIdx = dataUri.indexOf(',');
									if (commaIdx !== -1) {
										const prefix = dataUri.slice(
											0,
											commaIdx
										); // e.g. data:image/jpeg;base64
										const rawBase64 = dataUri.slice(
											commaIdx + 1
										);
										// Normalize base64: decode to binary and re-encode to standard base64 (fixes url-safe, padding, whitespace)
										try {
											const cleanBase64 = Buffer.from(
												rawBase64,
												'base64'
											).toString('base64');
											// Detect actual MIME type from content (ignore client claim if incorrect)
											const detectedMime =
												detectMimeTypeFromBase64(
													cleanBase64
												);
											// Extract declared mime for fallback
											const declaredMime =
												prefix
													.split(':')[1]
													?.split(';')[0] ||
												'image/jpeg';

											part.image_url.url = `data:${detectedMime || declaredMime};base64,${cleanBase64}`;
										} catch (e) {
											console.warn(
												'Failed to normalize base64 image data:',
												e
											);
											// Fallback to simple whitespace stripping if re-encoding fails
											part.image_url.url =
												part.image_url.url.replace(
													/\s+/g,
													''
												);
										}
									}
								}
							}
						});
					}
				});
			}

			const stream = Boolean(requestBody.stream);

			if (
				requestBody?.reasoning === undefined &&
				requestBody?.reasoning_effort !== undefined
			) {
				requestBody.reasoning = requestBody.reasoning_effort;
			}

			if (requestBody?.interaction) {
				const interactionBody = requestBody.interaction;
				const input =
					typeof interactionBody?.input === 'string'
						? interactionBody.input
						: typeof interactionBody?.input === 'object'
							? JSON.stringify(interactionBody.input)
							: '';
				const modelRaw =
					typeof interactionBody?.model === 'string'
						? interactionBody.model
						: typeof requestBody?.model === 'string'
							? requestBody.model
							: '';
				if (!modelRaw || !input) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: model and input are required for interactions mapping',
							timestamp: new Date().toISOString()
						});
					return;
				}

				const normalized = normalizeDeepResearchModel(
					modelRaw,
					typeof interactionBody?.agent === 'string'
						? interactionBody.agent
						: undefined
				);
				const interactionRequest: InteractionRequest = {
					model: normalized.model,
					input,
					tools: Array.isArray(interactionBody.tools)
						? interactionBody.tools
						: undefined,
					response_format:
						interactionBody.response_format &&
						typeof interactionBody.response_format === 'object'
							? interactionBody.response_format
							: undefined,
					generation_config:
						interactionBody.generation_config &&
						typeof interactionBody.generation_config === 'object'
							? interactionBody.generation_config
							: undefined,
					agent: normalized.agent,
					reasoning:
						interactionBody.reasoning ??
						interactionBody.reasoning_effort ??
						requestBody.reasoning
				};

				const secret = getInteractionsSigningSecret();
				const interactionId = createInteractionToken(
					interactionRequest,
					userApiKey,
					'openai-chat',
					INTERACTIONS_TOKEN_TTL_SECONDS,
					secret,
					modelRaw
				);

				const responseBody = {
					id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
					object: 'chat.completion',
					created: Math.floor(Date.now() / 1000),
					model: modelRaw,
					choices: [
						{
							index: 0,
							message: { role: 'assistant', content: '' },
							finish_reason: 'in_progress'
						}
					],
					interaction: { id: interactionId }
				};

				return response.json(responseBody);
			}

			// --- Block non-chat models with helpful error (or auto-fallback for image generation) ---
			const nonChatType = isNonChatModel(modelId);
			if (nonChatType) {
				if (
					nonChatType === 'image-gen' &&
					!isNanoBananaModel(modelId)
				) {
					const prompt =
						typeof requestBody?.prompt === 'string'
							? requestBody.prompt
							: extractTextFromMessages(rawMessages);
					const imageUrl = extractImageUrlFromMessages(rawMessages);
					await handleImageGenFallbackFromChatOrResponses({
						modelId,
						prompt,
						imageUrl,
						requestBody,
						request,
						response,
						source: 'chat',
						upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
					});
					return;
				}
				if (nonChatType === 'video-gen') {
					const prompt =
						typeof requestBody?.prompt === 'string'
							? requestBody.prompt
							: extractTextFromMessages(rawMessages);
					const imageUrl = extractImageUrlFromMessages(rawMessages);
						await handleVideoGenFallbackFromChatOrResponses({
							modelId,
							prompt,
							imageUrl,
							requestBody,
							request,
							response,
							source: 'chat',
							upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
							setVideoRequestCache
						});
					return;
				}
				if (
					!(nonChatType === 'image-gen' && isNanoBananaModel(modelId))
				) {
					const endpointMap: Record<string, string> = {
						tts: '/v1/audio/speech',
						stt: '/v1/audio/transcriptions',
						'image-gen': '/v1/images/generations',
						'video-gen': '/v1/videos',
						embedding: '/v1/embeddings'
					};
					const correctEndpoint =
						endpointMap[nonChatType] || 'the dedicated endpoint';
					if (!response.completed)
						return response.status(400).json({
							error: {
								message: `'${modelId}' is not a chat model and cannot be used with /v1/chat/completions. Use ${correctEndpoint} instead.`,
								type: 'invalid_request_error',
								param: 'model',
								code: 'model_not_supported'
							},
							timestamp: new Date().toISOString()
						});
					return;
				}
			}

			const effectiveStream = stream && !isImageModelId(modelId);
			const includeUsageInStream = Boolean(
				requestBody?.stream_options?.include_usage
			);

			// Per-request token check logic (remains commented out or implement as needed)

			const sharedMessageOptions: Partial<IMessage> = {
				system: requestBody.system,
				response_format: requestBody.response_format,
				max_tokens:
					typeof requestBody.max_tokens === 'number'
						? requestBody.max_tokens
						: undefined,
				max_output_tokens:
					typeof requestBody.max_output_tokens === 'number'
						? requestBody.max_output_tokens
						: undefined,
				temperature:
					typeof requestBody.temperature === 'number'
						? requestBody.temperature
						: undefined,
				top_p:
					typeof requestBody.top_p === 'number'
						? requestBody.top_p
						: undefined,
				metadata: requestBody.metadata,
				modalities: Array.isArray(requestBody.modalities)
					? requestBody.modalities
					: undefined,
				audio: requestBody.audio,
				tools: Array.isArray(requestBody.tools)
					? requestBody.tools
					: undefined,
				tool_choice: requestBody.tool_choice,
				reasoning: requestBody.reasoning,
				instructions: requestBody.instructions,
				stream_options:
					requestBody.stream_options &&
					typeof requestBody.stream_options === 'object'
						? requestBody.stream_options
						: undefined
			};
			if (isNanoBananaModel(modelId)) {
				sharedMessageOptions.modalities = ensureNanoBananaModalities(
					sharedMessageOptions.modalities
				);
			}

			const formattedMessages: IMessage[] = rawMessages.map(msg => ({
				...msg,
				model: { id: modelId },
				...sharedMessageOptions,
				image_fetch_referer: imageFetchReferer
			}));

			if (effectiveStream) {
				response.setHeader('Content-Type', 'text/event-stream');
				response.setHeader('Cache-Control', 'no-cache');
				response.setHeader('Connection', 'keep-alive');
				const stopSseHeartbeat = startSseHeartbeat(response);
				try {
					if (
						Array.isArray(requestBody.tools) &&
						requestBody.tools.length > 0
					) {
						const started = Date.now();
						const requestId = `chatcmpl-${Date.now()}`;
						const result = await messageHandler.handleMessages(
							formattedMessages,
							modelId,
							userApiKey,
							{ requestId: request.requestId }
						);
						const inferredToolCalls =
							!result.tool_calls || result.tool_calls.length === 0
								? inferToolCallsFromJsonText(
										result.response,
										requestBody.tools,
										requestBody.tool_choice
									)
								: undefined;
						const effectiveToolCalls =
							result.tool_calls && result.tool_calls.length > 0
								? result.tool_calls
								: inferredToolCalls;
						const assistantContent = effectiveToolCalls?.length
							? null
							: composeAssistantContent(
									result.response,
									result.reasoning,
									request.headers
								);
						if (
							(!effectiveToolCalls ||
								effectiveToolCalls.length === 0) &&
							(!assistantContent ||
								assistantContent.trim().length === 0)
						) {
							throw new Error(
								'Empty chat completion output from provider.'
							);
						}
						const streamingToolCalls =
							normalizeToolCallsForStream(effectiveToolCalls);

						const totalTokensUsed =
							typeof result.tokenUsage === 'number'
								? result.tokenUsage
								: 0;
						const promptTokensUsed =
							typeof result.promptTokens === 'number'
								? result.promptTokens
								: undefined;
						const completionTokensUsed =
							typeof result.completionTokens === 'number'
								? result.completionTokens
								: undefined;
						await updateUserTokenUsage(
							totalTokensUsed,
							userApiKey,
							{
								modelId,
								promptTokens: promptTokensUsed,
								completionTokens: completionTokensUsed
							}
						);

						const roleChunk = {
							id: requestId,
							object: 'chat.completion.chunk',
							created: Math.floor(started / 1000),
							model: modelId,
							choices: [
								{
									index: 0,
									delta: { role: 'assistant' },
									finish_reason: null
								}
							]
						};
						response.write(
							`data: ${JSON.stringify(roleChunk)}\n\n`
						);

						if (streamingToolCalls?.length) {
							const toolChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: streamingToolCalls
										},
										finish_reason: null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(toolChunk)}\n\n`
							);
						} else if (assistantContent) {
							const contentChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: { content: assistantContent },
										finish_reason: null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(contentChunk)}\n\n`
							);
						}

						const finalChunk = {
							id: requestId,
							object: 'chat.completion.chunk',
							created: Math.floor(started / 1000),
							model: modelId,
							choices: [
								{
									index: 0,
									delta: {},
									finish_reason: effectiveToolCalls?.length
										? 'tool_calls'
										: result.finish_reason || 'stop'
								}
							]
						};
						if (includeUsageInStream) {
							(finalChunk as any).usage = {
								prompt_tokens: promptTokensUsed,
								completion_tokens: completionTokensUsed,
								total_tokens: totalTokensUsed
							};
						}
						response.write(
							`data: ${JSON.stringify(finalChunk)}\n\n`
						);
						response.write(`data: [DONE]\n\n`);
						return response.end();
					}

					const shouldDisableChatPassthrough =
						(Array.isArray(requestBody.tools) &&
							requestBody.tools.length > 0) ||
						typeof requestBody.tool_choice !== 'undefined' ||
						typeof requestBody.reasoning !== 'undefined';
					const streamHandler =
						messageHandler.handleStreamingMessages(
							formattedMessages,
							modelId,
							userApiKey,
							{
								disablePassthrough:
									shouldDisableChatPassthrough,
								requestId: request.requestId
							}
						);
					const started = Date.now();
					const requestId = `chatcmpl-${Date.now()}`;

					let totalTokenUsage = 0;
					let passthroughHandled = false;
					let fallbackToNormalized = false;
					let promptTokensFromUsage: number | undefined;
					let completionTokensFromUsage: number | undefined;
					let promptTokensFinal: number | undefined;
					let completionTokensFinal: number | undefined;
					let streamOutputText = '';
					let toolCallsFromStream: any[] | undefined;
					let finishReasonFromStream: string | undefined;
					let sentAssistantRoleChunk = false;
					const canInferToolCallsFromText =
						Array.isArray(requestBody.tools) &&
						requestBody.tools.length > 0;
					let bufferingStructuredJson = false;
					let pendingReasoningText = '';

					for await (const result of streamHandler) {
						if (result.type === 'passthrough') {
							if (
								result?.passthrough?.mode !== 'openai-chat-sse'
							) {
								console.log(
									`[StreamPassthrough] Fallback used for /chat/completions due to mode mismatch (${result?.passthrough?.mode || 'unknown'}).`
								);
								try {
									result?.passthrough?.upstream?.destroy?.();
								} catch {}
								fallbackToNormalized = true;
								break;
							}

							passthroughHandled = true;
							stopSseHeartbeat();
							console.log(
								`[StreamPassthrough] Forwarding raw upstream SSE for /chat/completions via ${result.providerId}.`
							);
							let forwardedAnyBytes = false;

							const parser = createSseDataParser(dataLine => {
								if (!dataLine || dataLine === '[DONE]') return;
								try {
									const parsed = JSON.parse(dataLine);
									const deltaText =
										parsed?.choices?.[0]?.delta?.content;
									if (typeof deltaText === 'string')
										streamOutputText += deltaText;

									const usage = extractUsageTokens(
										parsed?.usage
									);
									if (typeof usage.promptTokens === 'number')
										promptTokensFromUsage =
											usage.promptTokens;
									if (
										typeof usage.completionTokens ===
										'number'
									)
										completionTokensFromUsage =
											usage.completionTokens;
									if (typeof usage.totalTokens === 'number')
										totalTokenUsage = usage.totalTokens;
								} catch {
									// Ignore malformed passthrough SSE data lines for accounting sidecar parsing.
								}
							});

							try {
								for await (const rawChunk of result.passthrough
									.upstream) {
									const chunkBuffer = Buffer.isBuffer(
										rawChunk
									)
										? rawChunk
										: Buffer.from(rawChunk);
									if (chunkBuffer.length > 0)
										forwardedAnyBytes = true;
									response.write(chunkBuffer);
									parser(chunkBuffer.toString('utf8'));
								}
							} catch (passthroughPipeError: any) {
								if (!forwardedAnyBytes) {
									console.warn(
										`[StreamPassthrough] Fallback used for /chat/completions due to passthrough pipe error before first byte: ${passthroughPipeError?.message || 'unknown error'}`
									);
									fallbackToNormalized = true;
									passthroughHandled = false;
									break;
								}
								throw passthroughPipeError;
							}
							break;
						} else if (result.type === 'chunk') {
							if (
								typeof result.reasoning === 'string' &&
								result.reasoning
							) {
								pendingReasoningText += result.reasoning;
							}
							const hasToolCallChunk =
								Array.isArray(result.tool_calls) &&
								result.tool_calls.length > 0;
							let chunkContent = hasToolCallChunk
								? ''
								: typeof result.chunk === 'string'
									? result.chunk
									: '';
							if (chunkContent && pendingReasoningText) {
								chunkContent = composeAssistantContent(
									chunkContent,
									pendingReasoningText,
									request.headers
								);
								pendingReasoningText = '';
							}
							if (hasToolCallChunk)
								toolCallsFromStream = result.tool_calls;
							if (result.finish_reason)
								finishReasonFromStream = result.finish_reason;
							if (chunkContent) streamOutputText += chunkContent;
							if (
								!toolCallsFromStream &&
								canInferToolCallsFromText
							) {
								const trimmedSoFar =
									streamOutputText.trimStart();
								if (
									bufferingStructuredJson ||
									trimmedSoFar.startsWith('{') ||
									trimmedSoFar.startsWith('[')
								) {
									bufferingStructuredJson = true;
								}
							}
							if (!sentAssistantRoleChunk) {
								const roleChunk = {
									id: requestId,
									object: 'chat.completion.chunk',
									created: Math.floor(started / 1000),
									model: modelId,
									choices: [
										{
											index: 0,
											delta: { role: 'assistant' },
											finish_reason: null
										}
									]
								};
								response.write(
									`data: ${JSON.stringify(roleChunk)}\n\n`
								);
								sentAssistantRoleChunk = true;
							}
							if (
								bufferingStructuredJson &&
								!toolCallsFromStream
							) {
								continue;
							}
							const hasContentChunk = chunkContent.length > 0;
							const streamedToolCalls = hasToolCallChunk
								? normalizeToolCallsForStream(result.tool_calls)
								: undefined;
							if (!hasContentChunk && !hasToolCallChunk) {
								continue;
							}
							const openaiStreamChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: {
											...(hasContentChunk
												? { content: chunkContent }
												: {}),
											...(streamedToolCalls &&
											streamedToolCalls.length > 0
												? {
														tool_calls:
															streamedToolCalls
													}
												: {})
										},
										finish_reason:
											result.finish_reason || null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(openaiStreamChunk)}\n\n`
							);
						} else if (result.type === 'final') {
							// Capture final metrics from the stream
							if (typeof result.tokenUsage === 'number')
								totalTokenUsage = result.tokenUsage;
							if (typeof result.promptTokens === 'number')
								promptTokensFinal = result.promptTokens;
							if (typeof result.completionTokens === 'number')
								completionTokensFinal = result.completionTokens;
							if (
								typeof result.response === 'string' &&
								result.response
							)
								streamOutputText = result.response;
							if (
								Array.isArray(result.tool_calls) &&
								result.tool_calls.length > 0
							)
								toolCallsFromStream = result.tool_calls;
							if (result.finish_reason)
								finishReasonFromStream = result.finish_reason;
						}
					}

					if (fallbackToNormalized) {
						const fallbackStreamHandler =
							messageHandler.handleStreamingMessages(
								formattedMessages,
								modelId,
								userApiKey,
								{
									disablePassthrough: true,
									requestId: request.requestId
								}
							);
						for await (const fallbackResult of fallbackStreamHandler) {
							if (fallbackResult.type === 'chunk') {
								if (
									typeof fallbackResult.reasoning ===
										'string' &&
									fallbackResult.reasoning
								) {
									pendingReasoningText +=
										fallbackResult.reasoning;
								}
								const hasFallbackToolCallChunk =
									Array.isArray(fallbackResult.tool_calls) &&
									fallbackResult.tool_calls.length > 0;
								let fallbackChunkContent =
									hasFallbackToolCallChunk
										? ''
										: typeof fallbackResult.chunk ===
											  'string'
											? fallbackResult.chunk
											: '';
								if (
									fallbackChunkContent &&
									pendingReasoningText
								) {
									fallbackChunkContent =
										composeAssistantContent(
											fallbackChunkContent,
											pendingReasoningText,
											request.headers
										);
									pendingReasoningText = '';
								}
								if (hasFallbackToolCallChunk)
									toolCallsFromStream =
										fallbackResult.tool_calls;
								if (fallbackResult.finish_reason)
									finishReasonFromStream =
										fallbackResult.finish_reason;
								if (fallbackChunkContent)
									streamOutputText += fallbackChunkContent;
								if (
									!toolCallsFromStream &&
									canInferToolCallsFromText
								) {
									const trimmedSoFar =
										streamOutputText.trimStart();
									if (
										bufferingStructuredJson ||
										trimmedSoFar.startsWith('{') ||
										trimmedSoFar.startsWith('[')
									) {
										bufferingStructuredJson = true;
									}
								}
								if (!sentAssistantRoleChunk) {
									const roleChunk = {
										id: requestId,
										object: 'chat.completion.chunk',
										created: Math.floor(started / 1000),
										model: modelId,
										choices: [
											{
												index: 0,
												delta: { role: 'assistant' },
												finish_reason: null
											}
										]
									};
									response.write(
										`data: ${JSON.stringify(roleChunk)}\n\n`
									);
									sentAssistantRoleChunk = true;
								}
								if (
									bufferingStructuredJson &&
									!toolCallsFromStream
								) {
									continue;
								}
								const hasFallbackContentChunk =
									fallbackChunkContent.length > 0;
								const streamedFallbackToolCalls =
									hasFallbackToolCallChunk
										? normalizeToolCallsForStream(
												fallbackResult.tool_calls
											)
										: undefined;
								if (
									!hasFallbackContentChunk &&
									!hasFallbackToolCallChunk
								) {
									continue;
								}
								const openaiStreamChunk = {
									id: requestId,
									object: 'chat.completion.chunk',
									created: Math.floor(started / 1000),
									model: modelId,
									choices: [
										{
											index: 0,
											delta: {
												...(hasFallbackContentChunk
													? {
															content:
																fallbackChunkContent
														}
													: {}),
												...(streamedFallbackToolCalls &&
												streamedFallbackToolCalls.length >
													0
													? {
															tool_calls:
																streamedFallbackToolCalls
														}
													: {})
											},
											finish_reason:
												fallbackResult.finish_reason ||
												null
										}
									]
								};
								response.write(
									`data: ${JSON.stringify(openaiStreamChunk)}\n\n`
								);
							} else if (fallbackResult.type === 'final') {
								if (fallbackResult.tokenUsage)
									totalTokenUsage = fallbackResult.tokenUsage;
								if (
									typeof fallbackResult.promptTokens ===
									'number'
								)
									promptTokensFinal =
										fallbackResult.promptTokens;
								if (
									typeof fallbackResult.completionTokens ===
									'number'
								)
									completionTokensFinal =
										fallbackResult.completionTokens;
								if (
									typeof fallbackResult.response ===
										'string' &&
									fallbackResult.response
								)
									streamOutputText = fallbackResult.response;
								if (
									Array.isArray(fallbackResult.tool_calls) &&
									fallbackResult.tool_calls.length > 0
								)
									toolCallsFromStream =
										fallbackResult.tool_calls;
								if (fallbackResult.finish_reason)
									finishReasonFromStream =
										fallbackResult.finish_reason;
							}
						}
					}

					if (
						pendingReasoningText &&
						(!toolCallsFromStream ||
							toolCallsFromStream.length === 0)
					) {
						if (!sentAssistantRoleChunk) {
							const roleChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: { role: 'assistant' },
										finish_reason: null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(roleChunk)}\n\n`
							);
							sentAssistantRoleChunk = true;
						}
						const bufferedReasoningContent =
							composeAssistantContent(
								'',
								pendingReasoningText,
								request.headers
							);
						streamOutputText += bufferedReasoningContent;
						response.write(
							`data: ${JSON.stringify({
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: {
											content: bufferedReasoningContent
										},
										finish_reason: null
									}
								]
							})}\n\n`
						);
						pendingReasoningText = '';
					}

					if (
						(!toolCallsFromStream ||
							toolCallsFromStream.length === 0) &&
						streamOutputText
					) {
						streamOutputText = composeAssistantContent(
							streamOutputText,
							undefined,
							request.headers
						);
					}

					if (passthroughHandled) {
						if (totalTokenUsage <= 0) {
							const promptEstimate =
								typeof promptTokensFromUsage === 'number'
									? promptTokensFromUsage
									: formattedMessages.reduce((sum, msg) => {
											return (
												sum +
												estimateTokensFromContent(
													msg.content
												)
											);
										}, 0);
							const completionEstimate =
								typeof completionTokensFromUsage === 'number'
									? completionTokensFromUsage
									: estimateTokensFromText(streamOutputText);
							totalTokenUsage =
								promptEstimate + completionEstimate;
						}

						await updateUserTokenUsage(
							totalTokenUsage,
							userApiKey,
							{ modelId }
						);
						if (!response.completed) return response.end();
						return;
					}

					const finalPromptTokens =
						typeof promptTokensFinal === 'number'
							? promptTokensFinal
							: typeof promptTokensFromUsage === 'number'
								? promptTokensFromUsage
								: formattedMessages.reduce(
										(sum, msg) =>
											sum +
											estimateTokensFromContent(
												msg.content
											),
										0
									);
					const finalCompletionTokens =
						typeof completionTokensFinal === 'number'
							? completionTokensFinal
							: typeof completionTokensFromUsage === 'number'
								? completionTokensFromUsage
								: estimateTokensFromText(streamOutputText);
					if (totalTokenUsage <= 0) {
						totalTokenUsage =
							finalPromptTokens + finalCompletionTokens;
					}

					await updateUserTokenUsage(totalTokenUsage, userApiKey, {
						modelId,
						promptTokens: finalPromptTokens,
						completionTokens: finalCompletionTokens
					});

					if (
						(!toolCallsFromStream ||
							toolCallsFromStream.length === 0) &&
						streamOutputText
					) {
						const inferredToolCalls = inferToolCallsFromJsonText(
							streamOutputText,
							requestBody.tools,
							requestBody.tool_choice
						);
						if (inferredToolCalls && inferredToolCalls.length > 0) {
							toolCallsFromStream = inferredToolCalls;
							finishReasonFromStream = 'tool_calls';
							const inferredToolChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: {
											tool_calls:
												normalizeToolCallsForStream(
													inferredToolCalls
												)
										},
										finish_reason: null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(inferredToolChunk)}\n\n`
							);
						} else if (
							bufferingStructuredJson &&
							streamOutputText
						) {
							const bufferedContentChunk = {
								id: requestId,
								object: 'chat.completion.chunk',
								created: Math.floor(started / 1000),
								model: modelId,
								choices: [
									{
										index: 0,
										delta: {
											content: streamOutputText
										},
										finish_reason: null
									}
								]
							};
							response.write(
								`data: ${JSON.stringify(bufferedContentChunk)}\n\n`
							);
						}
					}

					const finalChunk = {
						id: requestId,
						object: 'chat.completion.chunk',
						created: Math.floor(started / 1000),
						model: modelId,
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason:
									finishReasonFromStream ||
									(toolCallsFromStream?.length
										? 'tool_calls'
										: 'stop')
							}
						]
					};
					if (includeUsageInStream) {
						(finalChunk as any).usage = {
							prompt_tokens: finalPromptTokens,
							completion_tokens: finalCompletionTokens,
							total_tokens: totalTokenUsage
						};
					}
					response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
					response.write(`data: [DONE]\n\n`);
					return response.end();
				} finally {
					stopSseHeartbeat();
				}
			} else {
				// messageHandler call is already async
				const result = await messageHandler.handleMessages(
					formattedMessages,
					modelId,
					userApiKey,
					{ requestId: request.requestId }
				);
				const inferredToolCalls =
					!result.tool_calls || result.tool_calls.length === 0
						? inferToolCallsFromJsonText(
								result.response,
								requestBody.tools,
								requestBody.tool_choice
							)
						: undefined;
				const effectiveToolCalls =
					result.tool_calls && result.tool_calls.length > 0
						? result.tool_calls
						: inferredToolCalls;
				const assistantContent = effectiveToolCalls?.length
					? null
					: composeAssistantContent(
							result.response,
							result.reasoning,
							request.headers
						);
				if (
					(!effectiveToolCalls || effectiveToolCalls.length === 0) &&
					(!assistantContent || assistantContent.trim().length === 0)
				) {
					throw new Error(
						'Empty chat completion output from provider.'
					);
				}

				const totalTokensUsed =
					typeof result.tokenUsage === 'number'
						? result.tokenUsage
						: 0;
				const promptTokensUsed =
					typeof result.promptTokens === 'number'
						? result.promptTokens
						: undefined;
				const completionTokensUsed =
					typeof result.completionTokens === 'number'
						? result.completionTokens
						: undefined;
				await updateUserTokenUsage(totalTokensUsed, userApiKey, {
					modelId,
					promptTokens: promptTokensUsed,
					completionTokens: completionTokensUsed
				});

				// --- Format response strictly like OpenAI ---
				const openaiResponse = {
					id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
					object: 'chat.completion',
					created: Math.floor(Date.now() / 1000), // Unix timestamp
					model: modelId,
					// system_fingerprint: null, // OpenAI typically includes this. Set to null if not available.
					choices: [
						{
							index: 0,
							message: {
								role: 'assistant',
								content: assistantContent,
								...(effectiveToolCalls &&
								effectiveToolCalls.length > 0
									? { tool_calls: effectiveToolCalls }
									: {})
							},
							logprobs: null, // OpenAI includes this, set to null if not applicable
							finish_reason: effectiveToolCalls?.length
								? 'tool_calls'
								: result.finish_reason || 'stop'
						}
					],
					usage: {
						prompt_tokens: promptTokensUsed,
						completion_tokens: completionTokensUsed,
						total_tokens: totalTokensUsed
					}
					// Custom fields _latency_ms and _provider_id are removed
				};

				response.json(openaiResponse);
			}
		} catch (error: any) {
			attachQueueOverloadMetadata(error, requestQueue, {
				route: '/v1/chat/completions',
				lane: 'chat-completions'
			});
			await logError(error, request);
			const errorText = String(error?.message || '');
			console.error('Chat completions error:', errorText, error.stack);
			const timestamp = new Date().toISOString();
			let statusCode = 500;
			let clientMessage = 'Internal Server Error';
			let clientReference =
				'An unexpected error occurred while processing your chat request.';
			const errorMeta = error as any;
			const retryAfterSeconds = extractRetryAfterSeconds(errorText);
			const backpressureRetryAfterSeconds =
				getBackpressureRetryAfterSeconds(error);
			const rateLimitMessage = formatRateLimitMessage(retryAfterSeconds);
			const isFreeTierZeroQuota = isGeminiFreeTierZeroQuota(errorText);
			const errorModelId = errorMeta?.modelId;

			// All providers rate-limited — return 429 with Retry-After
			if (errorMeta?.code === 'MEMORY_PRESSURE') {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: server is under memory pressure. Retry in a few seconds.';
			} else if (
				errorMeta?.code === 'QUEUE_OVERLOADED' ||
				errorMeta?.code === 'QUEUE_WAIT_TIMEOUT'
			) {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: request queue is busy. Retry in a few seconds.';
			} else if (
				typeof errorMeta?.statusCode === 'number' &&
				errorMeta.statusCode >= 400 &&
				errorMeta.statusCode < 600
			) {
				statusCode = errorMeta.statusCode;
				clientMessage = errorText || clientMessage;
			} else if (isFreeTierZeroQuota) {
				statusCode = 403;
				clientMessage = errorModelId
					? `Model ${errorModelId} is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.`
					: 'This model is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.';
			} else if (errorMeta?.allSkippedByRateLimit) {
				statusCode = 429;
				clientMessage = rateLimitMessage;
			} else if (
				errorMeta?.code === 'INPUT_TOKENS_EXCEEDED' &&
				errorMeta?.hasImageInput
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image input too large for the model limit. Reduce image size or use a smaller image URL.';
			} else if (
				errorText.startsWith('Invalid request') ||
				errorText.startsWith('Failed to parse')
			) {
				statusCode = 400;
				clientMessage = `Bad Request: ${errorText}`;
			} else if (error instanceof SyntaxError) {
				statusCode = 400;
				clientMessage = 'Invalid JSON';
			} else if (isRateLimitError(errorText)) {
				statusCode = 429;
				clientMessage = rateLimitMessage;
			} else if (
				errorText.includes('Unauthorized') ||
				errorText.includes('limit reached')
			) {
				statusCode = errorText.includes('limit reached') ? 429 : 401;
				clientMessage = errorText.includes('limit reached')
					? rateLimitMessage
					: errorText;
			} else if (
				errorText.toLowerCase().includes('requires more credits') ||
				errorText.toLowerCase().includes('insufficient credits') ||
				errorText.toLowerCase().includes('can only afford') ||
				errorText.includes('status 402')
			) {
				statusCode = 402;
				clientMessage =
					'Payment Required: insufficient credits for the requested max_tokens. Reduce max_tokens or add credits to the provider key.';
			} else if (
				errorMeta?.code === 'model_not_allowed' ||
				errorText
					.toLowerCase()
					.includes('not available on your current plan')
			) {
				statusCode = 403;
				clientMessage =
					errorText ||
					'Forbidden: the requested model is not available on your current plan.';
			} else if (
				errorText.toLowerCase().includes('model not found') ||
				errorText.toLowerCase().includes('model_not_found')
			) {
				statusCode = 404;
				clientMessage =
					'Not Found: model does not exist or you do not have access to it.';
			} else if (
				errorText.toLowerCase().includes('image exceeds') ||
				errorText.toLowerCase().includes('image exceeds 5 mb')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image exceeds the provider size limit. Please resize or compress the image before sending.';
			} else if (
				errorText.toLowerCase().includes('input token count exceeds') ||
				errorText
					.toLowerCase()
					.includes('maximum number of tokens allowed')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: input token count exceeds the model limit. Reduce the prompt size or truncate history.';
			} else if (
				errorText.includes('fetching image from URL') ||
				errorText.includes('image_url') ||
				errorText
					.toLowerCase()
					.includes('cannot fetch content from the provided url')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image_url could not be fetched by the provider. Use a public, non-expiring URL or pass the image as base64 data.';
			} else if (errorText.includes('No suitable providers')) {
				statusCode = 503;
				clientMessage = errorText;
			} else if (
				errorText.includes('Provider') &&
				errorText.includes('failed')
			) {
				statusCode = 502;
				clientMessage = errorText;
			}

				if (
					response.started &&
					!response.completed &&
					response.getHeader('Content-Type') === 'text/event-stream'
				) {
					writeStreamingErrorAndClose(response, {
						message: clientMessage,
						statusCode,
						code:
							typeof errorMeta?.code === 'string'
								? errorMeta.code
								: undefined,
						reference: statusCode === 500 ? clientReference : undefined,
						timestamp
					});
					return;
				}

				if (!response.completed) {
					if (statusCode === 429 && retryAfterSeconds) {
						response.setHeader(
							'Retry-After',
						String(retryAfterSeconds)
					);
				}
				if (statusCode === 503 && backpressureRetryAfterSeconds) {
					response.setHeader(
						'Retry-After',
						String(backpressureRetryAfterSeconds)
					);
				}
				if (statusCode === 500) {
					response.status(statusCode).json({
						error: clientMessage,
						reference: clientReference,
						timestamp
					});
				} else {
					const payload: Record<string, any> = {
						error: clientMessage,
						timestamp
					};
					if (statusCode === 429 && retryAfterSeconds) {
						payload.retry_after_seconds = retryAfterSeconds;
					}
					if (statusCode === 503 && backpressureRetryAfterSeconds) {
						payload.retry_after_seconds =
							backpressureRetryAfterSeconds;
					}
					response.status(statusCode).json(payload);
				}
			} else {
				return;
			}
		}
	}
);

openaiRouter.post(
	'/responses/compact',
	async (request: Request, response: Response) => {
		if (!request.apiKey || !request.tierLimits) {
			await logError(
				{
					message:
						'Authentication or configuration failed in /v1/responses/compact after middleware'
				},
				request
			);
			if (!response.completed) {
				return response.status(401).json({
					error: 'Authentication or configuration failed',
					timestamp: new Date().toISOString()
				});
			}
			return;
		}

		try {
			const requestBody = await readJsonRequestBody(request, {
				label: RESPONSES_COMPACT_INTAKE_LABEL,
				extra: { route: '/v1/responses/compact' }
			});

			if (
				!requestBody?.model ||
				typeof requestBody.model !== 'string' ||
				!requestBody.model.trim()
			) {
				return response.status(400).json({
					error: {
						message: 'model parameter is required.',
						type: 'invalid_request_error',
						param: 'model',
						code: 'invalid_model'
					},
					timestamp: new Date().toISOString()
				});
			}

			const modelId = requestBody.model.trim();
			const previousResponseId =
				typeof requestBody?.previous_response_id === 'string' &&
				requestBody.previous_response_id.trim()
					? requestBody.previous_response_id.trim()
					: undefined;

			let normalizedInput: any[] = [];
			if (typeof requestBody?.input !== 'undefined') {
				try {
					normalizedInput = normalizeResponsesInputValue(
						requestBody.input
					);
				} catch (error: any) {
					return response.status(400).json({
						error: {
							message:
								error?.message || 'input must be a string, array, or object.',
							type: 'invalid_request_error',
							param: 'input',
							code: 'invalid_input'
						},
						timestamp: new Date().toISOString()
					});
				}
			}

			let sourceInput = cloneResponsesHistoryValue(normalizedInput);
			if (previousResponseId) {
				const previousEntry = await loadResponsesHistoryEntry(
					previousResponseId
				);
				if (!previousEntry) {
					return response.status(400).json({
						error: {
							message: `Previous response with id '${previousResponseId}' not found.`,
							type: 'invalid_request_error',
							param: 'previous_response_id',
							code: 'previous_response_not_found'
						},
						timestamp: new Date().toISOString()
					});
				}
				const mergedHistory = await mergeResponsesHistoryInput(
					previousEntry,
					sourceInput
				);
				sourceInput = cloneResponsesHistoryValue(mergedHistory.input);
			}

			if (!Array.isArray(sourceInput) || sourceInput.length === 0) {
				return response.status(400).json({
					error: {
						message:
							'input or previous_response_id is required for responses compaction.',
						type: 'invalid_request_error',
						param: 'input',
						code: 'invalid_input'
					},
					timestamp: new Date().toISOString()
				});
			}

			const summaryText =
				buildResponsesCompactionSummary(sourceInput);
			const createdAt = Math.floor(Date.now() / 1000);
			const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
			const compactionItem = createResponsesCompactionItem({
				model: modelId,
				summary: summaryText,
				sourceItemCount: sourceInput.length,
				createdAt
			});
			const outputItems = [compactionItem];
			const inputTokens = estimateResponsesCompactionTokens(sourceInput);
			const outputTokens = estimateResponsesCompactionTokens(outputItems);

			await saveResponsesHistoryEntry({
				id: responseId,
				model: modelId,
				input: cloneResponsesHistoryValue(outputItems),
				output: [],
				output_text: '',
				created: createdAt,
				replay_depth: 1,
				compacted: true
			});

			return response.json({
				id: responseId,
				object: 'response.compaction',
				created_at: createdAt,
				model: modelId,
				output: outputItems,
				usage: buildResponsesUsage({
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					total_tokens: inputTokens + outputTokens
				})
			});
		} catch (error: any) {
			await logError(error, request);
			const timestamp = new Date().toISOString();
			const message =
				typeof error?.message === 'string' && error.message.trim()
					? error.message
					: 'Internal Server Error';
			if (!response.completed) {
				return response.status(500).json({
					error: {
						message,
						type: 'server_error',
						code: 'internal_error'
					},
					timestamp
				});
			}
		}
	}
);

openaiRouter.post(
	'/responses',
	async (request: Request, response: Response) => {
		if (!request.apiKey || !request.tierLimits) {
			await logError(
				{
					message:
						'Authentication or configuration failed in /v1/responses after middleware'
				},
				request
			);
			if (!response.completed) {
				return response.status(401).json({
					error: 'Authentication or configuration failed',
					timestamp: new Date().toISOString()
				});
			} else {
				return;
			}
		}

		try {
			const requestBody = await readJsonRequestBody(request, {
				label: RESPONSES_INTAKE_LABEL,
				extra: { route: '/v1/responses' }
			});
			const userApiKey = request.apiKey!;

			if (
				requestBody?.reasoning === undefined &&
				requestBody?.reasoning_effort !== undefined
			) {
				requestBody.reasoning = requestBody.reasoning_effort;
			}

			if (requestBody?.interaction) {
				const interactionBody = requestBody.interaction;
				const input =
					typeof interactionBody?.input === 'string'
						? interactionBody.input
						: typeof interactionBody?.input === 'object'
							? JSON.stringify(interactionBody.input)
							: '';
				const modelRaw =
					typeof interactionBody?.model === 'string'
						? interactionBody.model
						: typeof requestBody?.model === 'string'
							? requestBody.model
							: '';
				if (!modelRaw || !input) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: model and input are required for interactions mapping',
							timestamp: new Date().toISOString()
						});
					return;
				}

				const normalized = normalizeDeepResearchModel(
					modelRaw,
					typeof interactionBody?.agent === 'string'
						? interactionBody.agent
						: undefined
				);
				const responseFormat = extractOpenAIResponseFormat(
					requestBody?.response_format
				);
				const interactionRequest: InteractionRequest = {
					model: normalized.model,
					input,
					tools: Array.isArray(interactionBody.tools)
						? interactionBody.tools
						: undefined,
					response_format: responseFormat,
					generation_config:
						interactionBody.generation_config &&
						typeof interactionBody.generation_config === 'object'
							? interactionBody.generation_config
							: undefined,
					agent: normalized.agent,
					reasoning:
						interactionBody.reasoning ??
						interactionBody.reasoning_effort ??
						requestBody.reasoning
				};

				const secret = getInteractionsSigningSecret();
				const interactionId = createInteractionToken(
					interactionRequest,
					userApiKey,
					'openai-responses',
					INTERACTIONS_TOKEN_TTL_SECONDS,
					secret,
					modelRaw
				);

				const responseBody = {
					id: `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
					object: 'response',
					created: Math.floor(Date.now() / 1000),
					model: modelRaw,
					status: 'in_progress',
					interaction: { id: interactionId },
					output: [],
					output_text: ''
				};
				return response.json(responseBody);
			}

			const { message, modelId, stream } =
				extractResponsesRequestBody(requestBody);
			const responsesHistoryInputDelta = Array.isArray(message.content)
				? cloneResponsesHistoryValue(message.content)
				: [cloneResponsesHistoryValue(message.content)];
			let responsesHistoryExpandedInputDelta: any[] =
				cloneResponsesHistoryValue(
					responsesHistoryInputDelta
				) as any[];
			let responsesHistoryMergedInput: any[] =
				cloneResponsesHistoryValue(
					responsesHistoryInputDelta
				) as any[];
			const localPreviousResponseId =
				typeof message.previous_response_id === 'string' &&
				message.previous_response_id.trim()
					? message.previous_response_id.trim()
					: undefined;
			let previousResponsesHistoryEntry: StoredResponsesHistoryEntry | null =
				null;
			if (localPreviousResponseId) {
				const previousEntry = await loadResponsesHistoryEntry(
					localPreviousResponseId
				);
				previousResponsesHistoryEntry = previousEntry;
				if (!previousEntry) {
					if (!response.completed) {
						return response.status(400).json({
							error: {
								message: `Previous response with id '${localPreviousResponseId}' not found.`,
								type: 'invalid_request_error',
								param: 'previous_response_id',
								code: 'previous_response_not_found'
							},
							timestamp: new Date().toISOString()
						});
					}
					return;
				}
				try {
					const mergedHistory = await mergeResponsesHistoryInput(
						previousEntry,
						responsesHistoryInputDelta
					);
					message.content = mergedHistory.input;
					responsesHistoryMergedInput = cloneResponsesHistoryValue(
						mergedHistory.input
					);
				} catch (historyError: any) {
					if (!response.completed) {
						return response.status(400).json({
							error: {
								message:
									historyError?.message ||
									'Stored responses history could not be reconstructed.',
								type: 'invalid_request_error',
								param: 'previous_response_id',
								code: 'previous_response_not_found'
							},
							timestamp: new Date().toISOString()
						});
					}
					return;
				}
				delete (message as any).previous_response_id;
			}
			if (Array.isArray(message.content)) {
				try {
					message.content = expandResponsesCompactionItems(
						message.content
					);
					responsesHistoryExpandedInputDelta =
						expandResponsesCompactionItems(
							responsesHistoryExpandedInputDelta
						);
				} catch (compactionError: any) {
					if (!response.completed) {
						return response.status(400).json({
							error: {
								message:
									compactionError?.message ||
									'Compaction input could not be decoded.',
								type: 'invalid_request_error',
								param: 'input',
								code: 'invalid_compaction_item'
							},
							timestamp: new Date().toISOString()
						});
					}
					return;
				}
			}
			let inlineCompactionItem: Record<string, any> | null = null;
			let inlineCompactionHistoryStoragePlan:
				| ResponsesHistoryStoragePlan
				| null = null;
			const inlineCompactThreshold =
				resolveResponsesCompactionThreshold(
					requestBody?.context_management ??
						requestBody?.extra_body?.context_management
				);
			if (
				inlineCompactThreshold &&
				Array.isArray(message.content) &&
				message.content.length > 1
			) {
				const fullInputItems = cloneResponsesHistoryValue(
					message.content
				);
				const keepTailCount =
					localPreviousResponseId &&
					Array.isArray(responsesHistoryExpandedInputDelta) &&
					responsesHistoryExpandedInputDelta.length > 0 &&
					fullInputItems.length >
						responsesHistoryExpandedInputDelta.length
						? responsesHistoryExpandedInputDelta.length
						: undefined;
				const keepStartIndex =
					findResponsesCompactionKeepStartIndex(
						fullInputItems,
						keepTailCount
					);
				const compactedHead = fullInputItems.slice(0, keepStartIndex);
				const keptTail = fullInputItems.slice(keepStartIndex);
				const estimatedInputTokens =
					estimateResponsesCompactionTokens(fullInputItems);
				if (
					estimatedInputTokens > inlineCompactThreshold &&
					compactedHead.length > 0 &&
					keptTail.length > 0
				) {
					inlineCompactionItem = createResponsesCompactionItem({
						model: modelId,
						summary:
							buildResponsesCompactionSummary(compactedHead),
						sourceItemCount: compactedHead.length,
						createdAt: Math.floor(Date.now() / 1000)
					});
					const compactedInput: any[] = [
						inlineCompactionItem,
						...keptTail
					];
					(message as any).content =
						expandResponsesCompactionItems(
							cloneResponsesHistoryValue(compactedInput)
						);
					responsesHistoryMergedInput =
						cloneResponsesHistoryValue(compactedInput);
					inlineCompactionHistoryStoragePlan = {
						input: cloneResponsesHistoryValue(compactedInput),
						replay_depth: 1,
						compacted: true
					};
				}
			}
			message.service_tier = getServiceTierForUserTier(request.userTier);
			const imageFetchReferer = normalizeImageFetchReferer(
				getHeaderValue(request.headers, 'x-image-fetch-referer') ||
					getHeaderValue(request.headers, 'x-image-referer')
			);
			if (imageFetchReferer) {
				message.image_fetch_referer = imageFetchReferer;
			}
			if (isNanoBananaModel(modelId)) {
				message.modalities = ensureNanoBananaModalities(
					message.modalities
				);
			}

			const nonChatType = isNonChatModel(modelId);
			if (nonChatType) {
				if (
					nonChatType === 'image-gen' &&
					!isNanoBananaModel(modelId)
				) {
					const prompt =
						typeof requestBody?.prompt === 'string'
							? requestBody.prompt
							: extractTextFromResponsesInput(requestBody?.input);
					const imageUrl = extractImageUrlFromResponsesInput(
						requestBody?.input
					);
					await handleImageGenFallbackFromChatOrResponses({
						modelId,
						prompt,
						imageUrl,
						requestBody,
						request,
						response,
						source: 'responses',
						upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
					});
					return;
				}
				if (nonChatType === 'video-gen') {
					const prompt =
						typeof requestBody?.prompt === 'string'
							? requestBody.prompt
							: extractTextFromResponsesInput(requestBody?.input);
					const imageUrl = extractImageUrlFromResponsesInput(
						requestBody?.input
					);
						await handleVideoGenFallbackFromChatOrResponses({
							modelId,
							prompt,
							imageUrl,
							requestBody,
							request,
							response,
							source: 'responses',
							upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
							setVideoRequestCache
						});
					return;
				}
				if (
					!(nonChatType === 'image-gen' && isNanoBananaModel(modelId))
				) {
					const endpointMap: Record<string, string> = {
						tts: '/v1/audio/speech',
						stt: '/v1/audio/transcriptions',
						'image-gen': '/v1/images/generations',
						'video-gen': '/v1/videos',
						embedding: '/v1/embeddings'
					};
					const correctEndpoint =
						endpointMap[nonChatType] || 'the dedicated endpoint';
					if (!response.completed) {
						return response.status(400).json({
							error: {
								message: `'${modelId}' is not a responses model and cannot be used with /v1/responses. Use ${correctEndpoint} instead.`,
								type: 'invalid_request_error',
								param: 'model',
								code: 'model_not_supported'
							},
							timestamp: new Date().toISOString()
						});
					}
					return;
				}
			}
			const effectiveStream = stream && !isImageModelId(modelId);
			if (message.tools || message.tool_choice) {
				const capsOk = await enforceModelCapabilities(
					modelId,
					['tool_calling'],
					response
				);
				if (!capsOk) return;
			}

			const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
			const created = Math.floor(Date.now() / 1000);
			const responseMessageId = createResponsesItemId('msg');
			const basePayload = {
				id: responseId,
				object: 'response',
				created,
				model: modelId
			};
			const resolveResponsesHistoryStoragePlan =
				(): ResponsesHistoryStoragePlan =>
					inlineCompactionHistoryStoragePlan || 
					buildResponsesHistoryStoragePlan({
						previousEntry: previousResponsesHistoryEntry,
						inputDelta: responsesHistoryInputDelta,
						fullInput: responsesHistoryMergedInput
					});

			if (effectiveStream) {
				response.setHeader('Content-Type', 'text/event-stream');
				response.setHeader('Cache-Control', 'no-cache');
				response.setHeader('Connection', 'keep-alive');
				const stopSseHeartbeat = startSseHeartbeat(response);
				try {
						// Always normalize /v1/responses streams through AnyGPT so
						// clients only ever see proxy-owned response IDs. That lets us
						// replay history locally across provider switches instead of
						// depending on upstream response stores.
						const shouldDisableResponsesPassthrough = true;
					const streamHandler =
						messageHandler.handleStreamingMessages(
							[message],
							modelId,
							userApiKey,
							{
								disablePassthrough:
									shouldDisableResponsesPassthrough,
								requestId: request.requestId
							}
						);
					let totalTokenUsage = 0;
					let fullText = '';
					let toolCallsFromStream: any[] | undefined;
					let finishReasonFromStream: string | undefined;
					let passthroughHandled = false;
					let fallbackToNormalized = false;
					let promptTokensFromUsage: number | undefined;
					let completionTokensFromUsage: number | undefined;
					let promptTokensFinal: number | undefined;
					let completionTokensFinal: number | undefined;
					let responsesCreatedSent = false;
					let responsesTextItemStarted = false;
					let inlineCompactionItemEmitted = false;
					let pendingReasoningText = '';
					let streamedReasoningText = '';
					const canInferResponsesToolCallsFromText =
						Array.isArray(message.tools) &&
						message.tools.length > 0;
					let bufferingStructuredJson = false;
					const reasoningItemId = createResponsesItemId('msg');
					let reasoningItemStarted = false;

					const persistResponsesStreamSideEffects = (
						outputText: string,
						totalTokens: number,
						promptTokens: number | undefined,
						completionTokens: number | undefined,
							toolCalls: any[] | undefined
						) => {
						void (async () => {
							const historyStoragePlan =
								resolveResponsesHistoryStoragePlan();
								try {
									await saveResponsesHistoryEntry({
										id: responseId,
										model: modelId,
										output: buildStoredResponsesHistoryOutput(
											outputText,
											toolCalls
										),
										output_text: outputText,
										created,
										...historyStoragePlan
									});
							} catch (historyError: any) {
								await logError(
									{
										message:
											'Failed to persist responses history entry after stream completion',
										errorMessage: historyError?.message,
										errorStack: historyError?.stack,
										context: {
											modelId,
											responseId,
											requestId: request.requestId
										}
									},
									request
								);
							}

							try {
								await updateUserTokenUsage(
									totalTokens,
									userApiKey,
									{ modelId, promptTokens, completionTokens }
								);
							} catch (usageError: any) {
								await logError(
									{
										message:
											'Failed to update token usage after responses stream completion',
										errorMessage: usageError?.message,
										errorStack: usageError?.stack,
										context: {
											modelId,
											responseId,
											requestId: request.requestId,
											totalTokens
										}
									},
									request
								);
							}
						})();
					};

					const getAssistantOutputIndex = () =>
						(inlineCompactionItem ? 1 : 0) +
						(reasoningItemStarted ? 1 : 0);
					const getReasoningOutputIndex = () =>
						inlineCompactionItem ? 1 : 0;

					const ensureResponsesCreated = () => {
						if (responsesCreatedSent) return;
						writeResponsesSseEvent(
							response,
							buildResponsesCreatedEvent({
								...basePayload,
								status: 'in_progress',
								output: [],
								output_text: ''
							})
						);
						responsesCreatedSent = true;
					};

					const ensureInlineCompactionItemEmitted = () => {
						if (!inlineCompactionItem || inlineCompactionItemEmitted)
							return;
						ensureResponsesCreated();
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemAddedEvent({
								responseId,
								outputIndex: 0,
								item: inlineCompactionItem
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemDoneEvent({
								responseId,
								outputIndex: 0,
								item: inlineCompactionItem
							})
						);
						inlineCompactionItemEmitted = true;
					};

					const ensureResponsesTextItemStarted = () => {
						ensureResponsesCreated();
						ensureInlineCompactionItemEmitted();
						if (responsesTextItemStarted) return;
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemAddedEvent({
								responseId,
								outputIndex: getAssistantOutputIndex(),
								item: createResponsesMessageItem('', {
									id: responseMessageId,
									status: 'in_progress'
								})
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesContentPartAddedEvent({
								responseId,
								itemId: responseMessageId,
								outputIndex: getAssistantOutputIndex(),
								contentIndex: 0,
								part: { type: 'output_text', text: '' }
							})
						);
						responsesTextItemStarted = true;
					};

					const ensureResponsesReasoningItemStarted = () => {
						ensureResponsesCreated();
						ensureInlineCompactionItemEmitted();
						if (reasoningItemStarted) return;
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemAddedEvent({
								responseId,
								outputIndex: getReasoningOutputIndex(),
								item: createResponsesReasoningItem('', {
									id: reasoningItemId,
									status: 'in_progress'
								})
							})
						);
						writeResponsesSseEvent(response, {
							type: 'response.reasoning_summary_part.added',
							response_id: responseId,
							item_id: reasoningItemId,
							output_index: getReasoningOutputIndex(),
							summary_index: 0,
							part: { type: 'summary_text', text: '' }
						});
						reasoningItemStarted = true;
					};

					for await (const result of streamHandler) {
						if (result.type === 'passthrough') {
							if (
								result?.passthrough?.mode !==
								'openai-responses-sse'
							) {
								console.log(
									`[StreamPassthrough] Fallback used for /responses due to mode mismatch (${result?.passthrough?.mode || 'unknown'}).`
								);
								try {
									result?.passthrough?.upstream?.destroy?.();
								} catch {}
								fallbackToNormalized = true;
								break;
							}

							passthroughHandled = true;
							stopSseHeartbeat();
							console.log(
								`[StreamPassthrough] Forwarding raw upstream SSE for /responses via ${result.providerId}.`
							);
							let forwardedAnyBytes = false;

							const parser = createSseDataParser(
								(dataLine, eventName) => {
									if (!dataLine || dataLine === '[DONE]')
										return;
									try {
										const parsed = JSON.parse(dataLine);
										const deltaText =
											parsed?.output_text_delta ||
											parsed?.delta ||
											parsed?.response
												?.output_text_delta ||
											parsed?.response?.delta ||
											parsed?.output?.[0]?.content?.[0]
												?.delta ||
											parsed?.output?.[0]?.content?.[0]
												?.text ||
											'';
										if (
											typeof deltaText === 'string' &&
											deltaText
										)
											fullText += deltaText;

										if (
											eventName === 'response.completed'
										) {
											const outputText =
												parsed?.output_text ||
												parsed?.response?.output_text;
											if (
												typeof outputText ===
													'string' &&
												outputText.length >
													fullText.length
											) {
												fullText = outputText;
											}
										}

										const usage = extractUsageTokens(
											parsed?.usage ||
												parsed?.response?.usage
										);
										if (
											typeof usage.promptTokens ===
											'number'
										)
											promptTokensFromUsage =
												usage.promptTokens;
										if (
											typeof usage.completionTokens ===
											'number'
										)
											completionTokensFromUsage =
												usage.completionTokens;
										if (
											typeof usage.totalTokens ===
											'number'
										)
											totalTokenUsage = usage.totalTokens;
									} catch {
										// Ignore malformed passthrough SSE data lines for accounting sidecar parsing.
									}
								}
							);

							try {
								for await (const rawChunk of result.passthrough
									.upstream) {
									const chunkBuffer = Buffer.isBuffer(
										rawChunk
									)
										? rawChunk
										: Buffer.from(rawChunk);
									if (chunkBuffer.length > 0)
										forwardedAnyBytes = true;
									response.write(chunkBuffer);
									parser(chunkBuffer.toString('utf8'));
								}
							} catch (passthroughPipeError: any) {
								if (!forwardedAnyBytes) {
									console.warn(
										`[StreamPassthrough] Fallback used for /responses due to passthrough pipe error before first byte: ${passthroughPipeError?.message || 'unknown error'}`
									);
									fallbackToNormalized = true;
									passthroughHandled = false;
									break;
								}
								throw passthroughPipeError;
							}

							break;
						} else if (result.type === 'chunk') {
							if (
								typeof result.reasoning === 'string' &&
								result.reasoning
							) {
								ensureResponsesReasoningItemStarted();
								streamedReasoningText += result.reasoning;
								writeResponsesSseEvent(response, {
									type: 'response.reasoning_summary_text.delta',
									response_id: responseId,
									item_id: reasoningItemId,
									output_index: 0,
									summary_index: 0,
									delta: result.reasoning
								});
							}
							if (
								Array.isArray(result.tool_calls) &&
								result.tool_calls.length > 0
							) {
								toolCallsFromStream = result.tool_calls;
							}
							if (result.finish_reason)
								finishReasonFromStream = result.finish_reason;
							if (
								typeof result.chunk === 'string' &&
								result.chunk.length > 0
							) {
								let deltaText = result.chunk;
								fullText += deltaText;
								if (
									!toolCallsFromStream &&
									canInferResponsesToolCallsFromText
								) {
									const inferred = inferToolCallsFromJsonText(
										fullText,
										message.tools,
										message.tool_choice
									);
									const trimmedSoFar = fullText.trimStart();
									if (inferred && inferred.length > 0) {
										toolCallsFromStream = inferred;
										finishReasonFromStream = 'tool_calls';
										bufferingStructuredJson = true;
										continue;
									}
									if (
										bufferingStructuredJson ||
										trimmedSoFar.startsWith('{') ||
										trimmedSoFar.startsWith('[')
									) {
										bufferingStructuredJson = true;
										continue;
									}
								}
								ensureResponsesTextItemStarted();
								writeResponsesSseEvent(
									response,
									buildResponsesOutputTextDeltaEvent({
										responseId,
										itemId: responseMessageId,
										outputIndex: 0,
										contentIndex: 0,
										delta: deltaText
									})
								);
							}
						} else if (result.type === 'final') {
							ensureResponsesCreated();
							if (typeof result.tokenUsage === 'number')
								totalTokenUsage = result.tokenUsage;
							if (typeof result.promptTokens === 'number')
								promptTokensFinal = result.promptTokens;
							if (typeof result.completionTokens === 'number')
								completionTokensFinal = result.completionTokens;
							if (
								Array.isArray(result.tool_calls) &&
								result.tool_calls.length > 0
							) {
								toolCallsFromStream = result.tool_calls;
							}
							if (result.finish_reason)
								finishReasonFromStream = result.finish_reason;
						}
					}

					if (fallbackToNormalized) {
						ensureResponsesCreated();

						const fallbackStreamHandler =
							messageHandler.handleStreamingMessages(
								[message],
								modelId,
								userApiKey,
								{
									disablePassthrough: true,
									requestId: request.requestId
								}
							);
						for await (const fallbackResult of fallbackStreamHandler) {
							if (fallbackResult.type === 'chunk') {
								if (
									typeof fallbackResult.reasoning ===
										'string' &&
									fallbackResult.reasoning
								) {
									ensureResponsesReasoningItemStarted();
									streamedReasoningText +=
										fallbackResult.reasoning;
									writeResponsesSseEvent(response, {
										type: 'response.reasoning_summary_text.delta',
										response_id: responseId,
										item_id: reasoningItemId,
										output_index: 0,
										summary_index: 0,
										delta: fallbackResult.reasoning
									});
								}
								if (
									typeof fallbackResult.chunk !== 'string' ||
									fallbackResult.chunk.length === 0
								) {
									continue;
								}
								if (
									Array.isArray(fallbackResult.tool_calls) &&
									fallbackResult.tool_calls.length > 0
								) {
									toolCallsFromStream =
										fallbackResult.tool_calls;
								}
								if (fallbackResult.finish_reason)
									finishReasonFromStream =
										fallbackResult.finish_reason;
								let fallbackDeltaText = fallbackResult.chunk;
								fullText += fallbackDeltaText;
								if (
									!toolCallsFromStream &&
									canInferResponsesToolCallsFromText
								) {
									const inferred = inferToolCallsFromJsonText(
										fullText,
										message.tools,
										message.tool_choice
									);
									const trimmedSoFar = fullText.trimStart();
									if (inferred && inferred.length > 0) {
										toolCallsFromStream = inferred;
										finishReasonFromStream = 'tool_calls';
										bufferingStructuredJson = true;
										continue;
									}
									if (
										bufferingStructuredJson ||
										trimmedSoFar.startsWith('{') ||
										trimmedSoFar.startsWith('[')
									) {
										bufferingStructuredJson = true;
										continue;
									}
								}
								ensureResponsesTextItemStarted();
								writeResponsesSseEvent(
									response,
									buildResponsesOutputTextDeltaEvent({
										responseId,
										itemId: responseMessageId,
										outputIndex: 0,
										contentIndex: 0,
										delta: fallbackDeltaText
									})
								);
							} else if (fallbackResult.type === 'final') {
								if (
									typeof fallbackResult.tokenUsage ===
									'number'
								)
									totalTokenUsage = fallbackResult.tokenUsage;
								if (
									typeof fallbackResult.promptTokens ===
									'number'
								)
									promptTokensFinal =
										fallbackResult.promptTokens;
								if (
									typeof fallbackResult.completionTokens ===
									'number'
								)
									completionTokensFinal =
										fallbackResult.completionTokens;
								if (
									Array.isArray(fallbackResult.tool_calls) &&
									fallbackResult.tool_calls.length > 0
								) {
									toolCallsFromStream =
										fallbackResult.tool_calls;
								}
								if (fallbackResult.finish_reason)
									finishReasonFromStream =
										fallbackResult.finish_reason;
							}
						}
					}

					if (
						(!toolCallsFromStream ||
							toolCallsFromStream.length === 0) &&
						fullText &&
						canInferResponsesToolCallsFromText
					) {
						const inferred = inferToolCallsFromJsonText(
							fullText,
							message.tools,
							message.tool_choice
						);
						if (inferred && inferred.length > 0) {
							toolCallsFromStream = inferred;
							finishReasonFromStream = 'tool_calls';
							bufferingStructuredJson = true;
						}
					}

					if (
						bufferingStructuredJson &&
						(!toolCallsFromStream ||
							toolCallsFromStream.length === 0) &&
						fullText
					) {
						ensureResponsesTextItemStarted();
						writeResponsesSseEvent(
							response,
							buildResponsesOutputTextDeltaEvent({
								responseId,
								itemId: responseMessageId,
								outputIndex: getAssistantOutputIndex(),
								contentIndex: 0,
								delta: fullText
							})
						);
					}

					if (passthroughHandled) {
						const finalPromptTokensForPassthrough =
							typeof promptTokensFromUsage === 'number'
								? promptTokensFromUsage
								: estimateTokensFromContent(message.content);
						const finalCompletionTokensForPassthrough =
							typeof completionTokensFromUsage === 'number'
								? completionTokensFromUsage
								: estimateTokensFromText(fullText);
						if (totalTokenUsage <= 0) {
							totalTokenUsage =
								finalPromptTokensForPassthrough +
								finalCompletionTokensForPassthrough;
						}

						persistResponsesStreamSideEffects(
							fullText,
							totalTokenUsage,
							finalPromptTokensForPassthrough,
							finalCompletionTokensForPassthrough,
							toolCallsFromStream
						);
						if (!response.completed) response.end();
						return;
					}

					const finalInputTokens =
						typeof promptTokensFinal === 'number'
							? promptTokensFinal
							: typeof promptTokensFromUsage === 'number'
								? promptTokensFromUsage
								: estimateTokensFromContent(message.content);
					const finalOutputTokens =
						typeof completionTokensFinal === 'number'
							? completionTokensFinal
							: typeof completionTokensFromUsage === 'number'
								? completionTokensFromUsage
								: estimateTokensFromText(fullText);
					if (totalTokenUsage <= 0) {
						totalTokenUsage = finalInputTokens + finalOutputTokens;
					}

					const finalPayload = buildResponsesResponseObject({
						id: responseId,
						created,
						model: modelId,
						outputText:
							toolCallsFromStream &&
							toolCallsFromStream.length > 0
								? ''
								: fullText,
						toolCalls: toolCallsFromStream,
						reasoningText: streamedReasoningText,
						reasoningId: streamedReasoningText
							? reasoningItemId
							: undefined,
						reasoningStatus: streamedReasoningText
							? 'completed'
							: undefined,
						status: 'completed',
						messageId: responseMessageId,
						messageStatus: 'completed',
						functionCallStatus: 'completed',
						usage: {
							input_tokens: finalInputTokens,
							output_tokens: finalOutputTokens,
							total_tokens: totalTokenUsage
						}
					});
					if (inlineCompactionItem) {
						finalPayload.output = [
							inlineCompactionItem,
							...(Array.isArray(finalPayload.output)
								? finalPayload.output
								: [])
						];
					}

					const finalOutputItems = Array.isArray(finalPayload.output)
						? finalPayload.output
						: [];
					if (reasoningItemStarted && streamedReasoningText) {
						writeResponsesSseEvent(response, {
							type: 'response.reasoning_summary_text.done',
							response_id: responseId,
							item_id: reasoningItemId,
							output_index: getReasoningOutputIndex(),
							summary_index: 0,
							text: streamedReasoningText
						});
						writeResponsesSseEvent(response, {
							type: 'response.reasoning_summary_part.done',
							response_id: responseId,
							item_id: reasoningItemId,
							output_index: getReasoningOutputIndex(),
							summary_index: 0,
							part: {
								type: 'summary_text',
								text: streamedReasoningText
							}
						});
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemDoneEvent({
								responseId,
								outputIndex: getReasoningOutputIndex(),
								item: createResponsesReasoningItem(
									streamedReasoningText,
									{ id: reasoningItemId, status: 'completed' }
								)
							})
						);
					}
					const assistantOutputIndex = finalOutputItems.findIndex(
						(item: any) =>
							item?.type === 'message' &&
							item?.role === 'assistant'
					);
					if (assistantOutputIndex >= 0) {
						const assistantItem =
							finalOutputItems[assistantOutputIndex];
						const assistantItemId =
							typeof assistantItem?.id === 'string' &&
							assistantItem.id.trim()
								? assistantItem.id.trim()
								: responseMessageId;
						const assistantPart =
							Array.isArray(assistantItem?.content) &&
							assistantItem.content.length > 0
								? assistantItem.content[0]
								: { type: 'output_text', text: fullText };
						ensureResponsesTextItemStarted();
						writeResponsesSseEvent(
							response,
							buildResponsesOutputTextDoneEvent({
								responseId,
								itemId: assistantItemId,
								outputIndex: assistantOutputIndex,
								contentIndex: 0,
								text: fullText
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesContentPartDoneEvent({
								responseId,
								itemId: assistantItemId,
								outputIndex: assistantOutputIndex,
								contentIndex: 0,
								part: assistantPart
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemDoneEvent({
								responseId,
								outputIndex: assistantOutputIndex,
								item: assistantItem
							})
						);
					}

					for (const [index, item] of finalOutputItems.entries()) {
						if (item?.type !== 'function_call') continue;
						ensureResponsesCreated();
						ensureInlineCompactionItemEmitted();
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemAddedEvent({
								responseId,
								outputIndex: index,
								item: { ...item, status: 'in_progress' }
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesFunctionCallArgumentsDoneEvent({
								responseId,
								itemId:
									typeof item?.id === 'string'
										? item.id
										: createResponsesItemId('fc'),
								outputIndex: index,
								callId:
									typeof item?.call_id === 'string'
										? item.call_id
										: undefined,
								name:
									typeof item?.name === 'string'
										? item.name
										: undefined,
								argumentsText:
									typeof item?.arguments === 'string'
										? item.arguments
										: undefined
							})
						);
						writeResponsesSseEvent(
							response,
							buildResponsesOutputItemDoneEvent({
								responseId,
								outputIndex: index,
								item
							})
						);
					}

					writeResponsesSseEvent(
						response,
						buildResponsesCompletedEvent(finalPayload)
					);
					response.write(`data: [DONE]\n\n`);
					if (!response.completed) response.end();
					persistResponsesStreamSideEffects(
						fullText,
						totalTokenUsage,
						finalInputTokens,
						finalOutputTokens,
						toolCallsFromStream
					);
					return;
				} finally {
					stopSseHeartbeat();
				}
			}

			const result = await messageHandler.handleMessages(
				[message],
				modelId,
				userApiKey,
				{ requestId: request.requestId }
			);
			const inferredToolCalls =
				!result.tool_calls || result.tool_calls.length === 0
					? inferToolCallsFromJsonText(
							result.response,
							Array.isArray(message.tools)
								? message.tools
								: undefined,
							message.tool_choice
						)
					: undefined;
			const effectiveToolCalls =
				result.tool_calls && result.tool_calls.length > 0
					? result.tool_calls
					: inferredToolCalls;
			const assistantContent = effectiveToolCalls?.length
				? ''
				: result.response;
			const totalTokensUsed =
				typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
			const promptTokensUsed =
				typeof result.promptTokens === 'number'
					? result.promptTokens
					: undefined;
			const completionTokensUsed =
				typeof result.completionTokens === 'number'
					? result.completionTokens
					: undefined;

			const outputText =
				effectiveToolCalls && effectiveToolCalls.length > 0
					? ''
					: assistantContent;
			if (
				(!effectiveToolCalls || effectiveToolCalls.length === 0) &&
				(!outputText || outputText.trim().length === 0)
			) {
				throw new Error('Empty responses output from provider.');
			}
			await updateUserTokenUsage(totalTokensUsed, userApiKey, {
				modelId,
				promptTokens: promptTokensUsed,
				completionTokens: completionTokensUsed
			});
				const responseBody = buildResponsesResponseObject({
					id: responseId,
					created,
					model: modelId,
					outputText,
					toolCalls: effectiveToolCalls,
					reasoningText:
						typeof result.reasoning === 'string'
							? result.reasoning
							: undefined,
					status: 'completed',
					usage: {
						input_tokens: promptTokensUsed,
						output_tokens: completionTokensUsed,
						total_tokens: totalTokensUsed
					}
				});
				if (inlineCompactionItem) {
					responseBody.output = [
						inlineCompactionItem,
						...(Array.isArray(responseBody.output)
							? responseBody.output
							: [])
					];
				}

				const historyStoragePlan =
					resolveResponsesHistoryStoragePlan();
				await saveResponsesHistoryEntry({
					id: responseId,
					model: modelId,
					output: buildStoredResponsesHistoryOutput(
						outputText,
						effectiveToolCalls
					),
					output_text: outputText,
					created,
					...historyStoragePlan
				});
			return response.json(responseBody);
		} catch (error: any) {
			attachQueueOverloadMetadata(error, requestQueue, {
				route: '/v1/responses',
				lane: 'responses'
			});
			await logError(error, request);
			const errorText = String(error?.message || '');
			console.error('Responses API error:', errorText, error.stack);
			const timestamp = new Date().toISOString();
			let statusCode = 500;
			let clientMessage = 'Internal Server Error';
			let clientReference =
				'An unexpected error occurred while processing your responses request.';
			const errorMeta = error as any;
			const retryAfterSeconds = extractRetryAfterSeconds(errorText);
			const backpressureRetryAfterSeconds =
				getBackpressureRetryAfterSeconds(error);
			const rateLimitMessage = formatRateLimitMessage(retryAfterSeconds);
			const isFreeTierZeroQuota = isGeminiFreeTierZeroQuota(errorText);
			const errorModelId = errorMeta?.modelId;

			// All providers rate-limited — return 429 with Retry-After
			if (errorMeta?.code === 'MEMORY_PRESSURE') {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: server is under memory pressure. Retry in a few seconds.';
			} else if (
				errorMeta?.code === 'QUEUE_OVERLOADED' ||
				errorMeta?.code === 'QUEUE_WAIT_TIMEOUT'
			) {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: request queue is busy. Retry in a few seconds.';
			} else if (
				typeof errorMeta?.statusCode === 'number' &&
				errorMeta.statusCode >= 400 &&
				errorMeta.statusCode < 600
			) {
				statusCode = errorMeta.statusCode;
				clientMessage = errorText || clientMessage;
			} else if (isFreeTierZeroQuota) {
				statusCode = 403;
				clientMessage = errorModelId
					? `Model ${errorModelId} is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.`
					: 'This model is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.';
			} else if (errorMeta?.allSkippedByRateLimit) {
				statusCode = 429;
				clientMessage = rateLimitMessage;
			} else if (
				errorMeta?.code === 'INPUT_TOKENS_EXCEEDED' &&
				errorMeta?.hasImageInput
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image input too large for the model limit. Reduce image size or use a smaller image URL.';
			} else if (
				errorText.startsWith('Invalid request') ||
				errorText.startsWith('Failed to parse') ||
				errorText.includes('input is required')
			) {
				statusCode = 400;
				clientMessage = `Bad Request: ${errorText}`;
			} else if (error instanceof SyntaxError) {
				statusCode = 400;
				clientMessage = 'Invalid JSON';
			} else if (isRateLimitError(errorText)) {
				statusCode = 429;
				clientMessage = rateLimitMessage;
			} else if (
				errorText.includes('Unauthorized') ||
				errorText.includes('limit reached')
			) {
				statusCode = errorText.includes('limit reached') ? 429 : 401;
				clientMessage = errorText.includes('limit reached')
					? rateLimitMessage
					: errorText;
			} else if (
				errorText.toLowerCase().includes('requires more credits') ||
				errorText.toLowerCase().includes('insufficient credits') ||
				errorText.toLowerCase().includes('can only afford') ||
				errorText.includes('status 402')
			) {
				statusCode = 402;
				clientMessage =
					'Payment Required: insufficient credits for the requested max_tokens. Reduce max_tokens or add credits to the provider key.';
			} else if (
				errorMeta?.code === 'model_not_allowed' ||
				errorText
					.toLowerCase()
					.includes('not available on your current plan')
			) {
				statusCode = 403;
				clientMessage =
					errorText ||
					'Forbidden: the requested model is not available on your current plan.';
			} else if (
				errorText.toLowerCase().includes('image exceeds') ||
				errorText.toLowerCase().includes('image exceeds 5 mb')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image exceeds the provider size limit. Please resize or compress the image before sending.';
			} else if (
				errorText.toLowerCase().includes('input token count exceeds') ||
				errorText
					.toLowerCase()
					.includes('maximum number of tokens allowed')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: input token count exceeds the model limit. Reduce the prompt size or truncate history.';
			} else if (
				errorText.includes('fetching image from URL') ||
				errorText.includes('image_url') ||
				errorText
					.toLowerCase()
					.includes('cannot fetch content from the provided url')
			) {
				statusCode = 400;
				clientMessage =
					'Bad Request: image_url could not be fetched by the provider. Use a public, non-expiring URL or pass the image as base64 data.';
			} else if (
				errorText.includes('No suitable providers') ||
				errorText.includes('supports model') ||
				errorText.includes('No provider')
			) {
				statusCode = 404;
				clientMessage = errorText;
			}

				if (
					response.started &&
					!response.completed &&
					response.getHeader('Content-Type') === 'text/event-stream'
				) {
					writeStreamingErrorAndClose(response, {
						message: clientMessage,
						statusCode,
						code:
							typeof errorMeta?.code === 'string'
								? errorMeta.code
								: undefined,
						reference: statusCode === 500 ? clientReference : undefined,
						timestamp
					});
					return;
				}

				if (!response.completed) {
					if (statusCode === 429 && retryAfterSeconds) {
						response.setHeader(
							'Retry-After',
						String(retryAfterSeconds)
					);
				}
				if (statusCode === 503 && backpressureRetryAfterSeconds) {
					response.setHeader(
						'Retry-After',
						String(backpressureRetryAfterSeconds)
					);
				}
				if (statusCode === 500) {
					response.status(statusCode).json({
						error: clientMessage,
						reference: clientReference,
						timestamp
					});
				} else {
					const payload: Record<string, any> = {
						error: clientMessage,
						timestamp
					};
					if (statusCode === 429 && retryAfterSeconds) {
						payload.retry_after_seconds = retryAfterSeconds;
					}
					if (statusCode === 503 && backpressureRetryAfterSeconds) {
						payload.retry_after_seconds =
							backpressureRetryAfterSeconds;
					}
					response.status(statusCode).json(payload);
				}
			} else {
				return;
			}
		}
	}
);

// --- Interactions (OpenAI-style mapping) ---
openaiRouter.post(
	'/interactions',
	async (request: Request, response: Response) => {
		if (!request.apiKey || !request.tierLimits) {
			await logError(
				{
					message:
						'Authentication or configuration failed in /v1/interactions after middleware'
				},
				request
			);
			if (!response.completed)
				return response.status(401).json({
					error: 'Authentication or configuration failed',
					timestamp: new Date().toISOString()
				});
			return;
		}

		try {
			const body = await request.json();
			const model =
				typeof body?.model === 'string' ? body.model.trim() : '';
			const input =
				typeof body?.input === 'string'
					? body.input
					: typeof body?.input === 'object'
						? JSON.stringify(body.input)
						: '';
			if (!model || !input) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: model and input are required',
						timestamp: new Date().toISOString()
					});
				return;
			}

			const normalized = normalizeDeepResearchModel(
				model,
				typeof body?.agent === 'string' ? body.agent : undefined
			);
			if (
				request.tierLimits &&
				!isModelAllowedForTier(normalized.model, request.tierLimits)
			) {
				if (!response.completed)
					return sendOpenAiPlanModelDenied(
						response,
						normalized.model,
						request.tierLimits
					);
				return;
			}
			if (
				body?.reasoning === undefined &&
				body?.reasoning_effort !== undefined
			) {
				body.reasoning = body.reasoning_effort;
			}
			const interactionRequest: InteractionRequest = {
				model: normalized.model,
				input,
				tools: Array.isArray(body.tools) ? body.tools : undefined,
				response_format:
					body.response_format &&
					typeof body.response_format === 'object'
						? body.response_format
						: undefined,
				generation_config:
					body.generation_config &&
					typeof body.generation_config === 'object'
						? body.generation_config
						: undefined,
				agent: normalized.agent,
				reasoning: body.reasoning
			};

			const secret = getInteractionsSigningSecret();
			const interactionId = createInteractionToken(
				interactionRequest,
				request.apiKey,
				'openai-responses',
				INTERACTIONS_TOKEN_TTL_SECONDS,
				secret,
				model
			);

			const responseBody = {
				id: interactionId,
				status: 'processing'
			};
			return response.json(responseBody);
		} catch (error: any) {
			await logError(error, request);
			if (!response.completed) {
				response.status(500).json({
					error: 'Internal Server Error',
					reference: 'Failed to create interaction.',
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

openaiRouter.get(
	'/interactions/:interactionId',
	async (request: Request, response: Response) => {
		if (
			!request.apiKey ||
			!request.tierLimits ||
			!request.params.interactionId
		) {
			await logError(
				{
					message:
						'Authentication or configuration failed in /v1/interactions poll after middleware'
				},
				request
			);
			if (!response.completed)
				return response.status(401).json({
					error: 'Authentication or configuration failed',
					timestamp: new Date().toISOString()
				});
			return;
		}

		try {
			const secret = getInteractionsSigningSecret();
			const payload = verifyInteractionToken(
				request.params.interactionId,
				request.apiKey,
				secret
			);
			const result = await executeGeminiInteraction(payload.request);
			const outputs = Array.isArray(result?.outputs)
				? result.outputs
				: [];
			const outputText =
				typeof outputs?.[0]?.text === 'string' ? outputs[0].text : '';
			const usage = result?.usage || {};
			const totalTokensUsed =
				typeof usage.total_tokens === 'number'
					? usage.total_tokens
					: typeof result?.usageMetadata?.totalTokenCount === 'number'
						? result.usageMetadata.totalTokenCount
						: 0;
			if (totalTokensUsed > 0) {
				await updateUserTokenUsage(totalTokensUsed, request.apiKey);
			}

			const responseBody = {
				id: request.params.interactionId,
				status: 'completed',
				outputs,
				output_text: outputText,
				usage
			};
			return response.json(responseBody);
		} catch (error: any) {
			await logError(error, request);
			let statusCode = 500;
			let clientMessage = 'Internal Server Error';
			if (String(error?.message || '').includes('expired'))
				statusCode = 410;
			if (String(error?.message || '').includes('Invalid'))
				statusCode = 400;
			if (!response.completed) {
				response.status(statusCode).json({
					error: clientMessage,
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

// --- Azure OpenAI Compatible Route ---
openaiRouter.post(
	'/deployments/:deploymentId/chat/completions',
	authAndUsageMiddleware,
	rateLimitMiddleware,
	async (request: Request, response: Response) => {
		// Middleware should have attached these if successful
		if (
			!request.apiKey ||
			!request.tierLimits ||
			!request.params.deploymentId
		) {
			await logError(
				{
					message:
						'Authentication or configuration failed (Azure route) after middleware'
				},
				request
			);
			if (!response.completed) {
				return response.status(401).json({
					error: 'Authentication or configuration failed (Azure route).',
					timestamp: new Date().toISOString()
				});
			} else {
				return;
			}
		}

		// Check for api-version query parameter (required by Azure)
		const apiVersion = request.query['api-version'];
		if (!apiVersion || typeof apiVersion !== 'string') {
			await logError(
				{
					message:
						'Bad Request: Missing or invalid api-version query parameter (Azure route)'
				},
				request
			);
			if (!response.completed) {
				return response.status(400).json({
					error: "Bad Request: Missing or invalid 'api-version' query parameter.",
					timestamp: new Date().toISOString()
				});
			} else {
				return;
			}
		}

		const userApiKey = request.apiKey!;
		const deploymentId = request.params.deploymentId; // Use deploymentId as the modelId
		const tierLimits = request.tierLimits!;

		try {
			// Extract messages using the same logic as the standard route
			const requestBody = await readJsonRequestBody(request, {
				label: AZURE_CHAT_COMPLETIONS_INTAKE_LABEL,
				extra: {
					route: '/v1/deployments/:deploymentId/chat/completions'
				}
			});
			let { messages: rawMessages } =
				extractMessageFromRequestBody(requestBody);
			rawMessages = filterValidChatMessages(rawMessages);
			if (rawMessages.length === 0) {
				return response.status(400).json({
					error: {
						message:
							'Bad Request: messages must include at least one message with a role.',
						type: 'invalid_request_error',
						param: 'messages',
						code: 'invalid_messages'
					},
					timestamp: new Date().toISOString()
				});
			}

			// Use deploymentId as model identifier for the handler
			const formattedMessages: IMessage[] = rawMessages.map(msg => ({
				...msg,
				model: { id: deploymentId }
			}));

			// Call the central message handler
			const result = await messageHandler.handleMessages(
				formattedMessages,
				deploymentId,
				userApiKey,
				{ requestId: request.requestId }
			);

			const totalTokensUsed =
				typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
			const promptTokensUsed =
				typeof result.promptTokens === 'number'
					? result.promptTokens
					: undefined;
			const completionTokensUsed =
				typeof result.completionTokens === 'number'
					? result.completionTokens
					: undefined;
			await updateUserTokenUsage(totalTokensUsed, userApiKey);

			// --- Format response strictly like OpenAI ---
			const openaiResponse = {
				id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: deploymentId, // Use deployment ID here as the model identifier
				// system_fingerprint: null, // Set to null if not available.
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant',
							content: result.response
						},
						logprobs: null, // Set to null if not applicable
						finish_reason: 'stop'
					}
				],
				usage: {
					prompt_tokens: promptTokensUsed,
					completion_tokens: completionTokensUsed,
					total_tokens: totalTokensUsed
				}
				// Custom fields _latency_ms and _provider_id are removed
			};

			response.json(openaiResponse);
		} catch (error: any) {
			await logError(error, request);
			console.error(
				'Azure Chat completions error:',
				error.message,
				error.stack
			);
			const timestamp = new Date().toISOString();
			let statusCode = 500;
			let clientMessage = 'Internal Server Error';
			let clientReference =
				'An unexpected error occurred while processing your Azure chat request.';
			const explicitStatusCode =
				typeof (error as any)?.statusCode === 'number'
					? (error as any).statusCode
					: null;
			const backpressureRetryAfterSeconds =
				getBackpressureRetryAfterSeconds(error);

			if ((error as any)?.code === 'MEMORY_PRESSURE') {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: server is under memory pressure. Retry in a few seconds.';
			} else if (
				(error as any)?.code === 'QUEUE_OVERLOADED' ||
				(error as any)?.code === 'QUEUE_WAIT_TIMEOUT'
			) {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable: request queue is busy. Retry in a few seconds.';
			} else if (
				explicitStatusCode &&
				explicitStatusCode >= 400 &&
				explicitStatusCode < 600
			) {
				statusCode = explicitStatusCode;
				clientMessage = error.message || clientMessage;
			} else if (
				error.message.startsWith('Invalid request') ||
				error.message.startsWith('Failed to parse')
			) {
				statusCode = 400;
				clientMessage = `Bad Request: ${error.message}`;
			} else if (error instanceof SyntaxError) {
				statusCode = 400;
				clientMessage = 'Invalid JSON';
			} else if (
				error.message.includes('Unauthorized') ||
				error.message.includes('limit reached')
			) {
				statusCode = error.message.includes('limit reached')
					? 429
					: 401;
				clientMessage = error.message;
			} else if (
				error.message.includes('No suitable providers') ||
				error.message.includes('supports model') ||
				error.message.includes('No provider')
			) {
				statusCode = 404;
				clientMessage = `Deployment not found or model unsupported: ${deploymentId}`;
			} else if (
				error.message.includes('Provider') &&
				error.message.includes('failed')
			) {
				statusCode = 502;
				clientMessage = error.message;
			} else if (error.message.includes('Failed to process request')) {
				statusCode = 503;
				clientMessage =
					'Service temporarily unavailable after multiple provider attempts.';
			}

			if (!response.completed) {
				if (statusCode === 503 && backpressureRetryAfterSeconds) {
					response.setHeader(
						'Retry-After',
						String(backpressureRetryAfterSeconds)
					);
				}
				if (statusCode === 500) {
					response.status(statusCode).json({
						error: clientMessage,
						reference: clientReference,
						timestamp
					});
				} else {
					const payload: Record<string, any> = {
						error: clientMessage,
						timestamp
					};
					if (statusCode === 503 && backpressureRetryAfterSeconds) {
						payload.retry_after_seconds =
							backpressureRetryAfterSeconds;
					}
					response.status(statusCode).json(payload);
				}
			} else {
				return;
			}
		}
	}
);

// --- TTS: /v1/audio/speech ---
openaiRouter.post(
	'/audio/speech',
	async (request: Request, response: Response) => {
		try {
			let body: any;
			try {
				body = await request.json();
			} catch (parseErr: any) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: invalid or missing JSON body',
						timestamp: new Date().toISOString()
					});
				return;
			}

			if (!body.model || typeof body.model !== 'string') {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: model is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const model = body.model;
			const nonChatType = isNonChatModel(model);
			if (nonChatType !== 'tts') {
				if (!response.completed) {
					return response.status(400).json({
						error: `Bad Request: '${model}' is not a TTS model. Use /v1/chat/completions or /v1/responses for text models.`,
						timestamp: new Date().toISOString()
					});
				}
				return;
			}
			if (
				request.tierLimits &&
				!isModelAllowedForTier(model, request.tierLimits)
			) {
				if (!response.completed)
					return sendOpenAiPlanModelDenied(
						response,
						model,
						request.tierLimits
					);
				return;
			}
			const input = typeof body?.input === 'string' ? body.input : '';
			const voice =
				typeof body?.voice === 'string' ? body.voice : 'alloy';
			const responseFormat =
				typeof body?.response_format === 'string'
					? body.response_format
					: 'mp3';
			const speed =
				typeof body?.speed === 'number' ? body.speed : undefined;
			const stream = Boolean(body?.stream);

			if (!input) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: input is required',
						timestamp: new Date().toISOString()
					});
				return;
			}

			const capsOk = await enforceModelCapabilities(
				model,
				['audio_output'],
				response
			);
			if (!capsOk) return;

			const provider = await pickOpenAIProviderKey(model, [
				'audio_output'
			]);
			if (!provider) {
				if (!response.completed)
					return response.status(503).json({
						error: 'No available provider for TTS',
						timestamp: new Date().toISOString()
					});
				return;
			}

			const upstreamUrl = `${provider.baseUrl}/v1/audio/speech`;
			const upstreamRes = await fetchWithTimeout(
				upstreamUrl,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${provider.apiKey}`
					},
					body: JSON.stringify({
						model,
						input,
						voice,
						response_format: responseFormat,
						speed,
						stream
					})
				},
				UPSTREAM_TIMEOUT_MS
			);

			if (!upstreamRes.ok) {
				const errText = await upstreamRes.text().catch(() => '');
				if (!response.completed)
					return response.status(upstreamRes.status).json({
						error: `TTS upstream error: ${errText || upstreamRes.statusText}`,
						timestamp: new Date().toISOString()
					});
				return;
			}

			const upstreamContentType = upstreamRes.headers.get('content-type');
			const contentType =
				upstreamContentType ||
				AUDIO_CONTENT_TYPES[responseFormat] ||
				'audio/mpeg';
			response.setHeader('Content-Type', contentType);

			if (stream && upstreamRes.body) {
				const reader = upstreamRes.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value && value.length > 0) {
						response.write(value);
					}
				}
				response.end();
			} else {
				const arrayBuffer = await upstreamRes.arrayBuffer();
				response.end(new Uint8Array(arrayBuffer));
			}

			await updateUserTokenUsage(
				Math.ceil(input.length / 4),
				request.apiKey!
			);
		} catch (error: any) {
			await logError(error, request);
			if (!response.completed)
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- STT: /v1/audio/transcriptions ---
openaiRouter.post(
	'/audio/transcriptions',
	async (request: Request, response: Response) => {
		try {
			// For multipart/form-data, we need to forward the raw body
			const contentType = request.headers['content-type'] || '';
			const model = request.query?.model;

			if (!model || typeof model !== 'string') {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: model is required (query param)',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const nonChatType = isNonChatModel(model);
			if (nonChatType !== 'stt') {
				if (!response.completed) {
					return response.status(400).json({
						error: `Bad Request: '${model}' is not a transcription model. Use /v1/chat/completions or /v1/responses for text models.`,
						timestamp: new Date().toISOString()
					});
				}
				return;
			}
			if (
				request.tierLimits &&
				!isModelAllowedForTier(model, request.tierLimits)
			) {
				if (!response.completed)
					return sendOpenAiPlanModelDenied(
						response,
						model,
						request.tierLimits
					);
				return;
			}

			const capsOk = await enforceModelCapabilities(
				model,
				['audio_input'],
				response
			);
			if (!capsOk) return;

			const provider = await pickOpenAIProviderKey(model, [
				'audio_input'
			]);
			if (!provider) {
				if (!response.completed)
					return response.status(503).json({
						error: 'No available provider for STT',
						timestamp: new Date().toISOString()
					});
				return;
			}

			// Read raw body as Buffer via the buffer() method
			const rawBody = await request.buffer();
			const upstreamUrl = `${provider.baseUrl}/v1/audio/transcriptions`;
			const upstreamRes = await fetchWithTimeout(
				upstreamUrl,
				{
					method: 'POST',
					headers: {
						'Content-Type': contentType,
						Authorization: `Bearer ${provider.apiKey}`
					},
					body: rawBody as any
				},
				UPSTREAM_TIMEOUT_MS
			);

			const resContentType =
				upstreamRes.headers.get('content-type') || 'application/json';
			response.setHeader('Content-Type', resContentType);

			if (!upstreamRes.ok) {
				const errText = await upstreamRes.text().catch(() => '');
				if (!response.completed) {
					response.status(upstreamRes.status).end(errText);
					return;
				}
				return;
			}

			const resBody = await upstreamRes.text();
			response.end(resBody);

			await updateUserTokenUsage(100, request.apiKey!); // Flat estimate for audio transcription
		} catch (error: any) {
			await logError(error, request);
			console.error('STT route error:', error.message);
			if (!response.completed)
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- Image Generation: /v1/images/generations ---
openaiRouter.post(
	'/images/generations',
	async (request: Request, response: Response) => {
		try {
			const body = await request.json();
			const model = typeof body?.model === 'string' ? body.model : '';
			const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
			if (!model) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: model is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const nonChatType = isNonChatModel(model);
			if (nonChatType !== 'image-gen') {
				if (!response.completed) {
					return response.status(400).json({
						error: `Bad Request: '${model}' is not an image generation model. Use /v1/chat/completions or /v1/responses for text models.`,
						timestamp: new Date().toISOString()
					});
				}
				return;
			}
			if (
				request.tierLimits &&
				!isModelAllowedForTier(model, request.tierLimits)
			) {
				if (!response.completed)
					return sendOpenAiPlanModelDenied(
						response,
						model,
						request.tierLimits
					);
				return;
			}
			if (!prompt) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: prompt is required',
						timestamp: new Date().toISOString()
					});
				return;
			}

			const capsOk = await enforceModelCapabilities(
				model,
				['image_output'],
				response
			);
			if (!capsOk) return;
			const { responseJson } = await requestImageGeneration({
				modelId: model,
				prompt,
				requestBody: body,
				upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
				userApiKey: request.apiKey || undefined,
				requestId: request.requestId
			});
				response.json(responseJson);

				const tokenEstimate = Math.ceil(prompt.length / 4) + 500; // prompt + generation cost estimate
				const imageCount = resolveImageBillingQuantity(body);
				await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
					modelId: model,
					pricingMetric: 'per_image',
					pricingQuantity: imageCount
				});
		} catch (error: any) {
			await logError(error, request);
			console.error('Image generation route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' &&
				error.statusCode >= 400 &&
				error.statusCode < 600
					? error.statusCode
					: String(error?.message || '').includes(
								'No available provider for image generation'
						  )
						? 503
						: 500;
			if (!response.completed) {
				response.status(statusCode).json({
					error:
						statusCode === 500
							? 'Internal Server Error'
							: error?.message || 'Image generation failed',
					timestamp: new Date().toISOString()
				});
			}
		}
	}
);

// --- Video Generation: preferred /v1/videos and legacy /v1/videos/generations ---
const handleVideoGenerationRequest = async (
	request: Request,
	response: Response
) => {
		try {
			const contentType = String(request.headers['content-type'] || '');
			let body: any = {};
			let model = '';
			let prompt = '';
			let billingRequestBody: any = {};
			let isMultipart = false;
			let multipartBody: Buffer | null = null;

		if (contentType.includes('multipart/form-data')) {
			isMultipart = true;
			multipartBody = await request.buffer();
			const boundary = contentType.split('boundary=')[1]?.trim();
			if (!boundary) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: boundary missing',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const parsed = parseMultipartBody(multipartBody, boundary);
			model =
				typeof parsed.fields.model === 'string'
					? parsed.fields.model
					: '';
				prompt =
					typeof parsed.fields.prompt === 'string'
						? parsed.fields.prompt
						: typeof parsed.fields.input === 'string'
							? parsed.fields.input
							: '';
				billingRequestBody = parsed.fields;
			} else {
				try {
					body = await request.json();
			} catch {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: invalid JSON',
						timestamp: new Date().toISOString()
					});
				return;
			}
			model = typeof body?.model === 'string' ? body.model : '';
				prompt =
					typeof body?.prompt === 'string'
						? body.prompt
						: typeof body?.input === 'string'
							? body.input
							: '';
				billingRequestBody = body;
			}
		if (!model) {
			if (!response.completed)
				return response.status(400).json({
					error: 'Bad Request: model is required',
					timestamp: new Date().toISOString()
				});
			return;
		}
		const nonChatType = isNonChatModel(model);
		if (nonChatType !== 'video-gen') {
			if (!response.completed) {
				return response.status(400).json({
					error: `Bad Request: '${model}' is not a video generation model. Use /v1/chat/completions or /v1/responses for text models.`,
					timestamp: new Date().toISOString()
				});
			}
			return;
		}
		if (
			request.tierLimits &&
			!isModelAllowedForTier(model, request.tierLimits)
		) {
			if (!response.completed)
				return sendOpenAiPlanModelDenied(
					response,
					model,
					request.tierLimits
				);
			return;
		}
		if (!prompt) {
			if (!response.completed)
				return response.status(400).json({
					error: 'Bad Request: prompt is required',
					timestamp: new Date().toISOString()
				});
			return;
		}

		const { responseJson, requestId, provider } =
			isMultipart && multipartBody
				? await requestVideoGenerationMultipart({
						modelId: model,
						contentType,
						body: multipartBody as any,
						upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
					})
				: await requestVideoGeneration({
						modelId: model,
						prompt,
						imageUrl: null,
						requestBody: body,
						upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
					});
			if (requestId) await setVideoRequestCache(String(requestId), provider);
			response.json(responseJson);

			const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
			const videoSeconds = resolveVideoBillingQuantity(billingRequestBody);
			await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
				modelId: model,
				pricingMetric: 'per_image',
				pricingQuantity: videoSeconds
			});
	} catch (error: any) {
		await logError(error, request);
		console.error('Video generation route error:', error.message);
		const statusCode =
			typeof error?.statusCode === 'number' &&
			error.statusCode >= 400 &&
			error.statusCode < 600
				? error.statusCode
				: String(error?.message || '').includes(
							'No available provider for video generation'
					  )
					? 503
					: 500;
		if (!response.completed) {
			response.status(statusCode).json({
				error:
					statusCode === 500
						? 'Internal Server Error'
						: error?.message || 'Video generation failed',
				timestamp: new Date().toISOString()
			});
		}
	}
};

openaiRouter.get('/videos', async (request: Request, response: Response) => {
	try {
		const { provider, upstreamRes } = await forwardVideoRequestToProviders({
			providersToTry: await getOpenAIVideoProvidersToTry(),
			pathname: '/videos',
			method: 'GET',
			upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
			rawQuery: request.query as Record<string, any> | undefined,
			label: 'Video list'
		});
		const resJson = await upstreamRes.json();
		if (Array.isArray(resJson?.data)) {
			await Promise.allSettled(
				resJson.data.map((item: any) =>
					typeof item?.id === 'string'
						? setVideoRequestCache(
								item.id,
								buildVideoRequestCacheProvider(
									provider,
									item,
									VIDEO_REQUEST_CACHE_TTL_MS
								)
						  )
						: Promise.resolve()
				)
			);
		}
		response.json(resJson);
	} catch (error: any) {
		await logError(error, request);
		console.error('Video list route error:', error.message);
		const statusCode =
			typeof error?.statusCode === 'number' ? error.statusCode : 500;
		if (!response.completed)
			response.status(statusCode).json({
				error: error?.message || 'Video list failed',
				timestamp: new Date().toISOString()
			});
	}
});

openaiRouter.post('/videos/generations', handleVideoGenerationRequest);
openaiRouter.post('/videos', handleVideoGenerationRequest);

openaiRouter.post(
	'/videos/edits',
	async (request: Request, response: Response) => {
		try {
			const parsedBody = await parseVideoForwardBody(request);
			const model = extractParsedVideoField(parsedBody, 'model');
			if (model) {
				const nonChatType = isNonChatModel(model);
				if (nonChatType !== 'video-gen') {
					if (!response.completed)
						return response.status(400).json({
							error: `Bad Request: '${model}' is not a video generation model.`,
							timestamp: new Date().toISOString()
						});
					return;
				}
			}
			const sourceVideoId = extractParsedVideoField(parsedBody, 'video');
			const { provider, upstreamRes } =
				await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry({
						resourceId: sourceVideoId || undefined,
						modelId: model || undefined
					}),
					pathname: '/videos/edits',
					method: 'POST',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					contentType: parsedBody.contentType,
					body: parsedBody.body,
					label: 'Video edit',
					retryableStatusCodes: getVideoResourceRetryableStatusCodes(
						sourceVideoId || undefined
					)
				});
			const resJson = await upstreamRes.json();
			if (typeof resJson?.id === 'string')
				await setVideoRequestCache(
					resJson.id,
					buildVideoRequestCacheProvider(
						provider,
						resJson,
						VIDEO_REQUEST_CACHE_TTL_MS
					)
				);
			response.json(resJson);

				const prompt = extractParsedVideoField(parsedBody, 'prompt');
				if (prompt) {
					const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
					const videoSeconds = resolveParsedVideoBillingQuantity(parsedBody);
					await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
						modelId: model || undefined,
						pricingMetric: 'per_image',
						pricingQuantity: videoSeconds
					});
				}
		} catch (error: any) {
			await logError(error, request);
			console.error('Video edits route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video edit failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

openaiRouter.post(
	'/videos/extensions',
	async (request: Request, response: Response) => {
		try {
			const parsedBody = await parseVideoForwardBody(request);
			const model = extractParsedVideoField(parsedBody, 'model');
			if (model) {
				const nonChatType = isNonChatModel(model);
				if (nonChatType !== 'video-gen') {
					if (!response.completed)
						return response.status(400).json({
							error: `Bad Request: '${model}' is not a video generation model.`,
							timestamp: new Date().toISOString()
						});
					return;
				}
			}
			const sourceVideoId = extractParsedVideoField(parsedBody, 'video');
			const { provider, upstreamRes } =
				await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry({
						resourceId: sourceVideoId || undefined,
						modelId: model || undefined
					}),
					pathname: '/videos/extensions',
					method: 'POST',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					contentType: parsedBody.contentType,
					body: parsedBody.body,
					label: 'Video extension',
					retryableStatusCodes: getVideoResourceRetryableStatusCodes(
						sourceVideoId || undefined
					)
				});
			const resJson = await upstreamRes.json();
			if (typeof resJson?.id === 'string')
				await setVideoRequestCache(
					resJson.id,
					buildVideoRequestCacheProvider(
						provider,
						resJson,
						VIDEO_REQUEST_CACHE_TTL_MS
					)
				);
			response.json(resJson);

				const prompt = extractParsedVideoField(parsedBody, 'prompt');
				if (prompt) {
					const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
					const videoSeconds = resolveParsedVideoBillingQuantity(parsedBody);
					await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
						modelId: model || undefined,
						pricingMetric: 'per_image',
						pricingQuantity: videoSeconds
					});
				}
		} catch (error: any) {
			await logError(error, request);
			console.error('Video extensions route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video extension failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

openaiRouter.post(
	'/videos/characters',
	async (request: Request, response: Response) => {
		try {
			const parsedBody = await parseVideoForwardBody(request, {
				multipartOnly: true
			});
			const { provider, upstreamRes } =
				await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry(),
					pathname: '/videos/characters',
					method: 'POST',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					contentType: parsedBody.contentType,
					body: parsedBody.body,
					label: 'Video character create'
				});
			const resJson = await upstreamRes.json();
			if (typeof resJson?.id === 'string')
				await setVideoRequestCache(
					resJson.id,
					buildVideoRequestCacheProvider(
						provider,
						resJson,
						VIDEO_REQUEST_CACHE_TTL_MS
					)
				);
			response.json(resJson);
		} catch (error: any) {
			await logError(error, request);
			console.error('Video characters route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video character creation failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

openaiRouter.get(
	'/videos/characters/:characterId',
	async (request: Request, response: Response) => {
		try {
			const characterId =
				typeof request.params?.characterId === 'string'
					? request.params.characterId
					: '';
			if (!characterId) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: characterId is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const { provider, upstreamRes } =
				await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry({
						resourceId: characterId
					}),
					pathname: `/videos/characters/${encodeURIComponent(characterId)}`,
					method: 'GET',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					label: 'Video character lookup',
					retryableStatusCodes:
						getVideoResourceRetryableStatusCodes(characterId)
				});
			const resJson = await upstreamRes.json();
			if (typeof resJson?.id === 'string')
				await setVideoRequestCache(
					resJson.id,
					buildVideoRequestCacheProvider(
						provider,
						resJson,
						VIDEO_REQUEST_CACHE_TTL_MS
					)
				);
			response.json(resJson);
		} catch (error: any) {
			await logError(error, request);
			console.error('Video character lookup route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video character lookup failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

openaiRouter.post(
	'/videos/:videoId/remix',
	async (request: Request, response: Response) => {
		try {
			const videoId =
				typeof request.params?.videoId === 'string'
					? request.params.videoId
					: '';
			if (!videoId) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: videoId is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			let body: any;
			try {
				body = await request.json();
			} catch {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: application/json required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const { provider, upstreamRes } =
				await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry({
						resourceId: videoId
					}),
					pathname: `/videos/${encodeURIComponent(videoId)}/remix`,
					method: 'POST',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					contentType: 'application/json',
					body: JSON.stringify(body),
					label: 'Video remix',
					retryableStatusCodes:
						getVideoResourceRetryableStatusCodes(videoId)
				});
			const resJson = await upstreamRes.json();
			if (typeof resJson?.id === 'string')
				await setVideoRequestCache(
					resJson.id,
					buildVideoRequestCacheProvider(
						provider,
						resJson,
						VIDEO_REQUEST_CACHE_TTL_MS
					)
				);
			response.json(resJson);

				const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
				if (prompt) {
					const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
					const videoSeconds = resolveVideoBillingQuantity(body);
					await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
						modelId:
							typeof body?.model === 'string' && body.model.trim()
								? body.model
								: undefined,
						pricingMetric: 'per_image',
						pricingQuantity: videoSeconds
					});
				}
		} catch (error: any) {
			await logError(error, request);
			console.error('Video remix route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video remix failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

async function getVideoProvidersToTry(
	requestId: string
): Promise<VideoRequestCacheProvider[]> {
	const cached = await getVideoRequestCache(requestId);
	if (isGeminiVideoCacheProvider(cached)) {
		return [cached];
	}
	if (isGeminiVideoRequestId(requestId)) {
		return [];
	}
	const inferredKind = inferVideoProviderKindFromRequestId(requestId);
	const fallbackProviders = (await listAnyVideoProviders())
		.filter(provider => !inferredKind || provider.kind === inferredKind)
		.map(provider => ({
			apiKey: provider.apiKey,
			baseUrl: provider.baseUrl,
			kind: provider.kind
		}));
	return cached
		? [
				cached,
				...fallbackProviders.filter(
					provider =>
						provider.apiKey !== cached.apiKey ||
						provider.baseUrl !== cached.baseUrl
				)
			]
		: fallbackProviders;
}

// --- Video Status: /v1/videos/{requestId} ---
openaiRouter.get(
	'/videos/:requestId',
	async (request: Request, response: Response) => {
		try {
			const requestId =
				typeof request.params?.requestId === 'string'
					? request.params.requestId
					: '';
			if (!requestId) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: requestId is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			if (isReservedVideoRouteSegment(requestId)) {
				if (!response.completed) {
					sendReservedVideoRouteMethodHint(
						response,
						request.method,
						requestId
					);
				}
				return;
			}

			const cachedProvider = await getVideoRequestCache(requestId);
			if (isGeminiVideoCacheProvider(cachedProvider)) {
				const operation = await getGeminiVideoOperation(
					cachedProvider,
					UPSTREAM_TIMEOUT_MS
				);
				const cacheUpdate = buildGeminiVideoCacheUpdate(
					cachedProvider,
					operation
				);
				const effectiveProvider = cacheUpdate || cachedProvider;
				if (cacheUpdate) {
					await setVideoRequestCache(requestId, cacheUpdate);
				}
				response.json(
					buildGeminiVideoStatusPayload(
						requestId,
						effectiveProvider,
						operation
					)
				);
				return;
			}
				if (isGeminiVideoRequestId(requestId)) {
					if (!response.completed) {
						response.status(404).json({
							error: 'Unknown or expired Gemini video request id',
							timestamp: new Date().toISOString()
					});
					}
					return;
				}
				const resolvedRequestId = resolveVideoLookupRequestId(
					requestId,
					cachedProvider
				);

				const providersToTry = await getVideoProvidersToTry(requestId);
				if (providersToTry.length === 0) {
				if (!response.completed)
					return response.status(503).json({
						error: 'No available provider for video status',
						timestamp: new Date().toISOString()
					});
				return;
			}

			let lastStatus = 503;
			let lastErrorText = 'No available provider for video status';
			for (const provider of providersToTry) {
				const upstreamUrl = `${provider.baseUrl}/v1/videos/${resolvedRequestId}`;
				const upstreamRes = await fetchWithTimeout(
					upstreamUrl,
					{
						method: 'GET',
						headers: {
							Authorization: `Bearer ${provider.apiKey}`
						}
					},
					UPSTREAM_TIMEOUT_MS
				);

				if (upstreamRes.ok) {
					const rawText = await upstreamRes.text().catch(() => '');
					if (!rawText.trim()) {
						if (!response.completed) {
							response.status(502).json({
								error: 'Video status upstream error: empty response body from provider',
								timestamp: new Date().toISOString()
							});
						}
						return;
					}

					let resJson: any;
					try {
						resJson = JSON.parse(rawText);
					} catch {
						if (!response.completed) {
							response.status(502).json({
								error: 'Video status upstream error: non-JSON response body from provider',
								timestamp: new Date().toISOString()
							});
							}
							return;
						}
						const effectiveRequestId =
							typeof resJson?.id === 'string' && resJson.id.trim()
								? resJson.id.trim()
								: resolvedRequestId;
						const nextCachedProvider = buildVideoRequestCacheProvider(
							{
								...(cachedProvider || {}),
								apiKey: provider.apiKey,
								baseUrl: provider.baseUrl,
								kind: provider.kind,
								activeRequestId: effectiveRequestId
							},
							resJson,
							VIDEO_REQUEST_CACHE_TTL_MS
						);
						await setVideoRequestCache(
							requestId,
							nextCachedProvider
						);
						if (effectiveRequestId !== requestId) {
							await setVideoRequestCache(
								effectiveRequestId,
								nextCachedProvider
							);
						}
						const retriedResponse = await attemptFailedVideoRetry({
							request,
							requestedRequestId: requestId,
							failedRequestId: effectiveRequestId,
							failedResponse: resJson,
							cachedProvider: nextCachedProvider
						});
						if (retriedResponse) {
							response.json(retriedResponse);
							return;
						}
						response.json(resJson);
						return;
					}

				lastStatus = upstreamRes.status;
				lastErrorText = await upstreamRes
					.text()
					.catch(() => upstreamRes.statusText || lastErrorText);
				if (
					![
						401, 403, 404, 405, 409, 423, 425, 429, 500, 501, 502,
						503, 504
					].includes(upstreamRes.status)
				) {
					break;
				}
			}

			if (!response.completed) {
				response.status(lastStatus).json({
					error: `Video status upstream error: ${lastErrorText}`,
					timestamp: new Date().toISOString()
				});
			}
		} catch (error: any) {
			await logError(error, request);
			console.error('Video status route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
		}
	}
);

openaiRouter.delete(
	'/videos/:requestId',
	async (request: Request, response: Response) => {
		try {
			const requestId =
				typeof request.params?.requestId === 'string'
					? request.params.requestId
					: '';
			if (!requestId) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: requestId is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			if (isReservedVideoRouteSegment(requestId)) {
				if (!response.completed) {
					sendReservedVideoRouteMethodHint(
						response,
						request.method,
						requestId
					);
				}
				return;
			}
			const cachedProvider = await getVideoRequestCache(requestId);
			if (isGeminiVideoCacheProvider(cachedProvider)) {
				if (!response.completed) {
					return response.status(405).json({
						error: 'Gemini Veo operations do not support DELETE /v1/videos/{id} in this API.',
						timestamp: new Date().toISOString()
					});
				}
				return;
			}
				if (isGeminiVideoRequestId(requestId)) {
					if (!response.completed) {
						return response.status(404).json({
							error: 'Unknown or expired Gemini video request id',
							timestamp: new Date().toISOString()
					});
					}
					return;
				}
				const resolvedRequestId = resolveVideoLookupRequestId(
					requestId,
					cachedProvider
				);
				const { upstreamRes } = await forwardVideoRequestToProviders({
					providersToTry: await getOpenAIVideoProvidersToTry({
						resourceId: requestId
					}),
					pathname: `/videos/${encodeURIComponent(resolvedRequestId)}`,
					method: 'DELETE',
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
					label: 'Video delete',
				retryableStatusCodes:
						getVideoResourceRetryableStatusCodes(requestId)
				});
				await deleteVideoRequestCache(requestId);
				if (resolvedRequestId !== requestId) {
					await deleteVideoRequestCache(resolvedRequestId);
				}
				const resJson = await upstreamRes.json().catch(() => ({}));
				response.json(resJson);
		} catch (error: any) {
			await logError(error, request);
			console.error('Video delete route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Video delete failed',
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- Video Content: /v1/videos/{requestId}/content ---
openaiRouter.get(
	'/videos/:requestId/content',
	async (request: Request, response: Response) => {
		try {
			const requestId =
				typeof request.params?.requestId === 'string'
					? request.params.requestId
					: '';
			if (!requestId) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: requestId is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			if (isReservedVideoRouteSegment(requestId)) {
				if (!response.completed) {
					sendReservedVideoRouteMethodHint(
						response,
						request.method,
						requestId
					);
				}
				return;
			}

			const cachedProvider = await getVideoRequestCache(requestId);
			if (isGeminiVideoCacheProvider(cachedProvider)) {
				const {
					upstreamRes,
					operation,
					contentUri,
					mimeType
				} = await downloadGeminiVideoContent({
					provider: cachedProvider,
					upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
				});
				const cacheUpdate =
					(operation &&
						buildGeminiVideoCacheUpdate(cachedProvider, operation)) ||
					(contentUri !== cachedProvider.contentUri
						? {
								...cachedProvider,
								contentUri,
								ttlMs:
									cachedProvider.ttlMs || VIDEO_REQUEST_CACHE_TTL_MS
						  }
						: null);
				if (cacheUpdate) {
					await setVideoRequestCache(requestId, cacheUpdate);
				}

				const contentType =
					upstreamRes.headers.get('content-type') ||
					mimeType ||
					'video/mp4';
				const contentLength = upstreamRes.headers.get('content-length');
				const cacheControl = upstreamRes.headers.get('cache-control');
				response.setHeader('Content-Type', contentType);
				if (contentLength)
					response.setHeader('Content-Length', contentLength);
				if (cacheControl)
					response.setHeader('Cache-Control', cacheControl);
				const arrayBuffer = await upstreamRes.arrayBuffer();
				response.end(new Uint8Array(arrayBuffer));
				return;
			}
				if (isGeminiVideoRequestId(requestId)) {
					if (!response.completed) {
						response.status(404).json({
							error: 'Unknown or expired Gemini video request id',
							timestamp: new Date().toISOString()
					});
					}
					return;
				}
				const resolvedRequestId = resolveVideoLookupRequestId(
					requestId,
					cachedProvider
				);

				const providersToTry = await getVideoProvidersToTry(requestId);
			if (providersToTry.length === 0) {
				if (!response.completed)
					return response.status(503).json({
						error: 'No available provider for video content',
						timestamp: new Date().toISOString()
					});
				return;
			}

			let lastStatus = 503;
			let lastErrorText = 'No available provider for video content';
				const forwardedQuery = buildForwardedQueryString(
					request.query as Record<string, any> | undefined
				);
				for (const provider of providersToTry) {
					const upstreamUrl = `${provider.baseUrl}/v1/videos/${resolvedRequestId}/content${forwardedQuery}`;
					const upstreamRes = await fetchWithTimeout(
						upstreamUrl,
					{
						method: 'GET',
						headers: {
							Authorization: `Bearer ${provider.apiKey}`
						}
					},
					UPSTREAM_TIMEOUT_MS
				);

					if (upstreamRes.status === 200) {
						const nextCachedProvider = buildVideoRequestCacheProvider(
							{
								...(cachedProvider || {}),
								apiKey: provider.apiKey,
								baseUrl: provider.baseUrl,
								kind: provider.kind,
								activeRequestId: resolvedRequestId
							},
							undefined,
							VIDEO_REQUEST_CACHE_TTL_MS
						);
						await setVideoRequestCache(
							requestId,
							nextCachedProvider
						);
						if (resolvedRequestId !== requestId) {
							await setVideoRequestCache(
								resolvedRequestId,
								nextCachedProvider
							);
						}
						const contentType =
							upstreamRes.headers.get('content-type') || 'video/mp4';
					const contentLength =
						upstreamRes.headers.get('content-length');
					const cacheControl =
						upstreamRes.headers.get('cache-control');
					response.setHeader('Content-Type', contentType);
					if (contentLength)
						response.setHeader('Content-Length', contentLength);
					if (cacheControl)
						response.setHeader('Cache-Control', cacheControl);

					const arrayBuffer = await upstreamRes.arrayBuffer();
					response.end(new Uint8Array(arrayBuffer));
					return;
				}

				lastStatus = upstreamRes.status;
				lastErrorText = await upstreamRes
					.text()
					.catch(() => upstreamRes.statusText || lastErrorText);
				if (
					![
						401, 403, 404, 405, 409, 423, 425, 429, 500, 501, 502,
						503, 504
					].includes(upstreamRes.status)
				) {
					break;
				}
			}

			if (!response.completed) {
				response.status(lastStatus).json({
					error: `Video content upstream error: ${lastErrorText}`,
					timestamp: new Date().toISOString()
				});
			}
		} catch (error: any) {
			await logError(error, request);
			console.error('Video content route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' ? error.statusCode : 500;
			if (!response.completed)
				response.status(statusCode).json({
					error: error?.message || 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- Embeddings: /v1/embeddings ---
openaiRouter.post(
	'/embeddings',
	async (request: Request, response: Response) => {
		if (
			!(await authAndUsageMiddleware(request, response, () => {})) &&
			!request.apiKey
		)
			return;
		try {
			return await embeddingsQueue.run(async () => {
				let body: any;
				try {
					body = await request.json();
				} catch (e) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: invalid JSON',
							timestamp: new Date().toISOString()
						});
					return;
				}

				const model = typeof body?.model === 'string' ? body.model : '';
				let input: any = body?.input;

				if (!model) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: model is required',
							timestamp: new Date().toISOString()
						});
					return;
				}

				if (!input) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: input is required',
							timestamp: new Date().toISOString()
						});
					return;
				}
				if (
					request.tierLimits &&
					!isModelAllowedForTier(model, request.tierLimits)
				) {
					if (!response.completed)
						return sendOpenAiPlanModelDenied(
							response,
							model,
							request.tierLimits
						);
					return;
				}

				const tokensUsed = Array.isArray(input)
					? input.reduce(
							(acc: number, s: string) =>
								acc +
								estimateTokensFromText(String(s), 'input'),
							0
						)
					: estimateTokensFromText(String(input), 'input');
				const encodingFormat = body?.encoding_format;

				const provider = await pickEmbeddingProviderKey(model);
				if (!provider) {
					if (!response.completed)
						return response.status(503).json({
							error: 'No available provider for embeddings',
							timestamp: new Date().toISOString()
						});
					return;
				}

				if (provider.kind === 'gemini') {
					const normalizedInputs =
						normalizeGeminiEmbeddingInput(input);
					if (!normalizedInputs || normalizedInputs.length === 0) {
						if (!response.completed) {
							return response.status(400).json({
								error: 'Bad Request: Gemini embedding models require input as a string or array of strings.',
								timestamp: new Date().toISOString()
							});
						}
						return;
					}

					const modelPath = toGeminiEmbeddingModelPath(model);
					const geminiRequestBase: Record<string, any> = {};
					if (
						typeof body?.dimensions === 'number' &&
						Number.isFinite(body.dimensions) &&
						body.dimensions > 0
					) {
						geminiRequestBase.outputDimensionality = Math.floor(
							body.dimensions
						);
					}

					body = undefined;
					input = undefined;

					const upstreamUrl =
						normalizedInputs.length === 1
							? `${provider.baseUrl}/${modelPath}:embedContent`
							: `${provider.baseUrl}/${modelPath}:batchEmbedContents`;
					const upstreamPayload =
						normalizedInputs.length === 1
							? {
									model: modelPath,
									content: {
										parts: [{ text: normalizedInputs[0] }]
									},
									...geminiRequestBase
								}
							: {
									requests: normalizedInputs.map(text => ({
										model: modelPath,
										content: { parts: [{ text }] },
										...geminiRequestBase
									}))
								};
					const upstreamRes = await fetchWithTimeout(
						upstreamUrl,
						{
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'x-goog-api-key': provider.apiKey
							},
							body: JSON.stringify(upstreamPayload)
						},
						UPSTREAM_TIMEOUT_MS
					);

					if (!upstreamRes.ok) {
						const errText = await upstreamRes
							.text()
							.catch(() => '');
						if (!response.completed) {
							return response.status(upstreamRes.status).json({
								error: `Embeddings upstream error: ${errText || upstreamRes.statusText}`,
								timestamp: new Date().toISOString()
							});
						}
						return;
					}

					const upstreamJson = await upstreamRes
						.json()
						.catch(() => ({}));
					const vectors = Array.isArray(upstreamJson?.embeddings)
						? upstreamJson.embeddings.map((entry: any) =>
								Array.isArray(entry?.values)
									? entry.values.map((value: any) =>
											Number(value)
										)
									: []
							)
						: Array.isArray(upstreamJson?.embedding?.values)
							? [
									upstreamJson.embedding.values.map(
										(value: any) => Number(value)
									)
								]
							: [];
					if (vectors.length === 0) {
						if (!response.completed) {
							return response.status(502).json({
								error: 'Embeddings upstream error: Gemini returned no embedding vectors.',
								timestamp: new Date().toISOString()
							});
						}
						return;
					}

					return response.json(
						buildOpenAIEmbeddingResponse(
							model,
							vectors,
							tokensUsed,
							encodingFormat
						)
					);
				}

				const upstreamPayload = JSON.stringify({
					model,
					input,
					encoding_format: encodingFormat,
					dimensions: body.dimensions,
					user: body.user
				});
				body = undefined;

				const upstreamUrl = `${provider.baseUrl}/v1/embeddings`;
				const upstreamRes = await fetchWithTimeout(
					upstreamUrl,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${provider.apiKey}`
						},
						body: upstreamPayload
					},
					UPSTREAM_TIMEOUT_MS
				);
				input = undefined;

				if (!upstreamRes.ok) {
					const errText = await upstreamRes.text().catch(() => '');
					if (!response.completed)
						return response.status(upstreamRes.status).json({
							error: `Embeddings upstream error: ${errText || upstreamRes.statusText}`,
							timestamp: new Date().toISOString()
						});
					return;
				}

				response.status(upstreamRes.status);
				response.setHeader(
					'Content-Type',
					upstreamRes.headers.get('content-type') ||
						'application/json'
				);

				if (upstreamRes.body) {
					const reader = upstreamRes.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value && value.length > 0) response.write(value);
					}
					response.end();
				} else {
					response.end(await upstreamRes.text());
				}

				await updateUserTokenUsage(tokensUsed, request.apiKey!);
			});
		} catch (error: any) {
			await logError(error, request);
			console.error('Embeddings route error:', error.message);
			const statusCode =
				typeof error?.statusCode === 'number' &&
				error.statusCode >= 400 &&
				error.statusCode < 600
					? error.statusCode
					: 500;
			const message =
				statusCode === 500
					? 'Internal Server Error'
					: String(error?.message || '') || 'Request failed';
			if (!response.completed)
				response.status(statusCode).json({
					error: message,
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- Image Edits: /v1/images/edits ---
openaiRouter.post(
	'/images/edits',
	async (request: Request, response: Response) => {
		try {
			const contentType = request.headers['content-type'] || '';
			let model = '';
			let prompt = '';
			let upstreamBody: any;
			let upstreamContentType = contentType;
			let parsedBody: any = null;

			if (contentType.includes('application/json')) {
				parsedBody = await request.json();
				model =
					typeof parsedBody?.model === 'string'
						? parsedBody.model
						: '';
				prompt =
					typeof parsedBody?.prompt === 'string'
						? parsedBody.prompt
						: '';
				upstreamBody = JSON.stringify(parsedBody);
				upstreamContentType = 'application/json';
				} else if (contentType.includes('multipart/form-data')) {
					const rawBody = await request.buffer();
					const boundary = contentType.split('boundary=')[1]?.trim();
				if (!boundary) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: boundary missing',
							timestamp: new Date().toISOString()
						});
					return;
				}

					// Parse just to extract model/validation, but forward raw buffer
					const parsed = parseMultipartBody(rawBody, boundary);
					parsedBody = parsed.fields;
					model = parsed.fields['model'];
					prompt = parsed.fields['prompt'];

				// Check for image file
				if (!parsed.files.some(f => f.fieldName === 'image')) {
					if (!response.completed)
						return response.status(400).json({
							error: 'Bad Request: image file is required',
							timestamp: new Date().toISOString()
						});
					return;
				}

				upstreamBody = rawBody as any;
			} else {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: application/json or multipart/form-data required',
						timestamp: new Date().toISOString()
					});
				return;
			}

			if (!model) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: model is required',
						timestamp: new Date().toISOString()
					});
				return;
			}
			const nonChatType = isNonChatModel(model);
			if (nonChatType !== 'image-gen') {
				if (!response.completed) {
					return response.status(400).json({
						error: `Bad Request: '${model}' is not an image generation model. Use /v1/chat/completions or /v1/responses for text models.`,
						timestamp: new Date().toISOString()
					});
				}
				return;
			}

			if (!prompt) {
				if (!response.completed)
					return response.status(400).json({
						error: 'Bad Request: prompt is required',
						timestamp: new Date().toISOString()
					});
				return;
			}

			const capsOk = await enforceModelCapabilities(
				model,
				['image_input', 'image_output'],
				response
			);
			if (!capsOk) return;

			const resJson = await requestImageEdit({
				modelId: model,
				contentType: upstreamContentType,
				body: upstreamBody,
				upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
			});
				response.json(resJson);

				const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
				const imageCount = resolveImageBillingQuantity(parsedBody);
				await updateUserTokenUsage(tokenEstimate, request.apiKey!, {
					modelId: model,
					pricingMetric: 'per_image',
					pricingQuantity: imageCount
				});
		} catch (error: any) {
			await logError(error, request);
			console.error('Image edits route error:', error.message);
			if (!response.completed)
				response.status(500).json({
					error: 'Internal Server Error',
					timestamp: new Date().toISOString()
				});
		}
	}
);

// --- Audio Voices: /v1/audio/voices ---
openaiRouter.get(
	'/audio/voices',
	async (request: Request, response: Response) => {
		// Basic response simulating OpenAI-compatible voice list
		const voices = [
			{ voice_id: 'alloy', name: 'Alloy', category: 'openai' },
			{ voice_id: 'echo', name: 'Echo', category: 'openai' },
			{ voice_id: 'fable', name: 'Fable', category: 'openai' },
			{ voice_id: 'onyx', name: 'Onyx', category: 'openai' },
			{ voice_id: 'nova', name: 'Nova', category: 'openai' },
			{ voice_id: 'shimmer', name: 'Shimmer', category: 'openai' }
		];
		response.json({ voices });
	}
);

// --- Audio Models: /v1/audio/models ---
openaiRouter.get(
	'/audio/models',
	async (request: Request, response: Response) => {
		const models = [
			{
				id: 'tts-1',
				object: 'model',
				created: 1699046015,
				owned_by: 'openai'
			},
			{
				id: 'tts-1-hd',
				object: 'model',
				created: 1699046015,
				owned_by: 'openai'
			},
			{
				id: 'whisper-1',
				object: 'model',
				created: 1677610602,
				owned_by: 'openai'
			}
		];
		response.json({ object: 'list', data: models });
	}
);

export default openaiRouter;
