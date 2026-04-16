import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import {
	runAuthMiddleware,
	runRateLimitMiddleware,
	normalizeApiKey
} from '../modules/middlewareFactory.js';
import type { RequestTimestampStore } from '../modules/rateLimit.js';
import { logError } from '../modules/errorLogger.js';
import { updateUserTokenUsage, type TierData } from '../modules/userData.js';
import { extractMessageFromRequestBody } from '../modules/userData.js';
import {
	buildModelAccessError,
	isModelAllowedForTier
} from '../modules/planAccess.js';
import {
	dataManager,
	type LoadedProviderData,
	type LoadedProviders
} from '../modules/dataManager.js';
import redis from '../modules/db.js';
import { fetchWithTimeout } from '../modules/http.js';
import { logger } from '../modules/logger.js';
import { createResponsesItemId } from '../modules/openaiResponsesFormat.js';
import {
	createSseDataParser,
	extractUsageTokens,
	getHeaderValue
} from '../modules/openaiRequestSupport.js';
import {
	getBackpressureRetryAfterSeconds,
	withBufferedRequestBody
} from '../modules/requestIntake.js';
import { redactToken } from '../modules/redaction.js';
import { getRequestQueueForLane } from '../modules/requestQueue.js';
import {
	applyResponseHeaders,
	applyRouteCorsHeaders,
	buildModelsPayload
} from './models.js';
import { filterValidChatMessages } from '../modules/openaiRouteUtils.js';
import {
	type ResponsesHistoryStoragePlan,
	type StoredResponsesHistoryEntry,
	buildResponsesHistoryStoragePlan,
	buildStoredResponsesHistoryOutput,
	cloneResponsesHistoryValue,
	loadResponsesHistoryEntry,
	mergeResponsesHistoryInput,
	saveResponsesHistoryEntry
} from '../modules/responsesHistory.js';
import {
	buildResponsesCompactionSummary,
	createResponsesCompactionItem,
	estimateResponsesCompactionTokens,
	expandResponsesCompactionItems,
	findResponsesCompactionKeepStartIndex,
	resolveResponsesCompactionThreshold
} from '../modules/responsesCompaction.js';

dotenv.config();

const router = new HyperExpress.Router();
const requestTimestamps: RequestTimestampStore = {};
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
	'connection',
	'content-length',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);
const SAFE_NATIVE_RESPONSE_HEADERS = new Set([
	'cache-control',
	'content-disposition',
	'content-type',
	'retry-after'
]);
const NATIVE_ROUTE_CORS_ALLOW_METHODS = [
	'GET',
	'HEAD',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS'
] as const;
const NATIVE_ROUTE_CORS_EXPOSE_HEADERS = [
	'Cache-Control',
	'Content-Disposition',
	'Content-Type',
	'Retry-After',
	'X-AnyGPT-Routed-Family',
	'X-AnyGPT-Native-Proxy-Mode'
] as const;
const nativeProviderCooldowns = new Map<string, number>();
const DEFAULT_NATIVE_PROVIDER_COOLDOWN_MS = (() => {
	const raw = Number(process.env.NATIVE_PROVIDER_COOLDOWN_MS ?? 60_000);
	return Number.isFinite(raw) && raw > 0
		? Math.max(1_000, Math.ceil(raw))
		: 60_000;
})();
const DEFAULT_NATIVE_OPENAI_CHAT_MAX_MESSAGES = (() => {
	const raw = Number(process.env.NATIVE_OPENAI_CHAT_MAX_MESSAGES ?? 48);
	if (!Number.isFinite(raw)) return 48;
	if (raw <= 0) return 0;
	return Math.max(1, Math.floor(raw));
})();
const DEFAULT_NATIVE_FORGE_CHAT_MAX_MESSAGES = (() => {
	const raw = Number(process.env.NATIVE_FORGE_CHAT_MAX_MESSAGES ?? 32);
	if (!Number.isFinite(raw)) return 32;
	if (raw <= 0) return 0;
	return Math.max(1, Math.floor(raw));
})();
const NATIVE_STRICT_PASSTHROUGH = !/^(0|false|no|off)$/i.test(
	String(process.env.NATIVE_STRICT_PASSTHROUGH || 'true').trim()
);
const FORGE_TRACE_ENABLED = /^(1|true|yes|on)$/i.test(
	String(process.env.ANYGPT_FORGE_TRACE || '').trim()
);
const NATIVE_RESPONSES_PROVIDER_PIN_TTL_SECONDS = (() => {
	const raw = Number(
		process.env.NATIVE_RESPONSES_PROVIDER_PIN_TTL_SECONDS ?? 12 * 60 * 60
	);
	return Number.isFinite(raw) && raw > 0
		? Math.max(60, Math.floor(raw))
		: 12 * 60 * 60;
})();
const NATIVE_RESPONSES_PROVIDER_PIN_MEMORY_MAX_ENTRIES = (() => {
	const raw = Number(
		process.env.NATIVE_RESPONSES_PROVIDER_PIN_MEMORY_MAX_ENTRIES ?? 512
	);
	return Number.isFinite(raw) && raw > 0
		? Math.max(16, Math.floor(raw))
		: 512;
})();
const NATIVE_RESPONSES_PROVIDER_PIN_REDIS_PREFIX =
	'api:native_responses_provider_pin:';
const nativeResponsesProviderPinMemory = new Map<
	string,
	{ providerId: string; expiresAt: number }
>();

type NativeFamily =
	| 'openai'
	| 'anthropic'
	| 'gemini'
	| 'openrouter'
	| 'deepseek'
	| 'xai';

type NativeFamilyAlias = NativeFamily | 'claude' | 'google' | 'x-ai';

const OPENAI_COMPATIBLE_NATIVE_FAMILIES = new Set<NativeFamily>([
	'openai',
	'openrouter',
	'deepseek',
	'xai'
]);

type NativeResponsesHistoryContinuationMode =
	| 'fresh'
	| 'replay'
	| 'native-upstream';

type NativeResponsesHistoryContext = {
	proxyResponseId: string;
	ownerScope?: string;
	inputDelta: any[];
	mergedInput: any[];
	previousEntry: StoredResponsesHistoryEntry | null;
	continuationMode: NativeResponsesHistoryContinuationMode;
	storagePlanOverride?: ResponsesHistoryStoragePlan | null;
};

function summarizeTraceOutputItems(output: any): string[] {
	if (!Array.isArray(output)) return [];
	return output
		.map(item =>
			item && typeof item === 'object' && typeof item.type === 'string'
				? item.type
				: typeof item
		)
		.slice(0, 12);
}

function countTraceToolCalls(output: any): number {
	if (!Array.isArray(output)) return 0;
	let count = 0;
	for (const item of output) {
		if (!item || typeof item !== 'object') continue;
		if (item.type === 'function_call') {
			count += 1;
			continue;
		}
		if (!Array.isArray((item as any).content)) continue;
		for (const part of (item as any).content) {
			if (
				part &&
				typeof part === 'object' &&
				part.type === 'tool_calls' &&
				Array.isArray((part as any).tool_calls)
			) {
				count += (part as any).tool_calls.length;
			}
		}
	}
	return count;
}

function countTraceReasoningItems(output: any): number {
	if (!Array.isArray(output)) return 0;
	return output.filter(
		item => item && typeof item === 'object' && item.type === 'reasoning'
	).length;
}

function readTraceHeader(
	request: Pick<Request, 'headers'>,
	name: string
): string | undefined {
	const value = getHeaderValue(request.headers, name);
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function detectTraceClient(
	request: Pick<Request, 'headers'>
): string | undefined {
	const candidates = [
		readTraceHeader(request, 'user-agent'),
		readTraceHeader(request, 'x-client'),
		readTraceHeader(request, 'x-requested-with'),
		readTraceHeader(request, 'x-anygpt-internal-client')
	].filter(Boolean) as string[];
	const haystack = candidates.join(' | ').toLowerCase();
	if (!haystack) return undefined;
	if (haystack.includes('forge')) return 'forge';
	if (haystack.includes('copilot')) return 'copilot';
	if (haystack.includes('github')) return 'github';
	return candidates[0];
}

function logForgeTrace(phase: string, payload: Record<string, unknown>): void {
	if (!FORGE_TRACE_ENABLED) return;
	logger.info(`[ForgeTrace][native][${phase}]`, payload);
}

function canonicalizeNativeFamily(raw: string): NativeFamily | null {
	const normalized = String(raw || '')
		.trim()
		.toLowerCase();
	if (!normalized) return null;
	if (normalized === 'openai') return 'openai';
	if (normalized === 'anthropic' || normalized === 'claude')
		return 'anthropic';
	if (normalized === 'gemini' || normalized === 'google') return 'gemini';
	if (normalized === 'openrouter') return 'openrouter';
	if (normalized === 'deepseek') return 'deepseek';
	if (normalized === 'xai' || normalized === 'x-ai') return 'xai';
	return null;
}

function isAutoNativeFamilySelector(raw: string): boolean {
	const normalized = String(raw || '')
		.trim()
		.toLowerCase();
	return normalized === 'auto' || normalized === 'mutual';
}

function providerFamilyToNativeFamily(rawFamily: string): NativeFamily | null {
	const normalized = String(rawFamily || '')
		.trim()
		.toLowerCase();
	if (!normalized) return null;
	if (normalized === 'openai') return 'openai';
	if (normalized === 'anthropic') return 'anthropic';
	if (normalized === 'gemini') return 'gemini';
	if (normalized === 'openrouter') return 'openrouter';
	if (normalized === 'deepseek') return 'deepseek';
	if (normalized === 'xai') return 'xai';
	if (normalized === 'mock') return 'openai';
	return null;
}

function normalizeAutoRoutedNativeFamily(
	family: NativeFamily | null | undefined
): NativeFamily | null {
	if (!family) return null;
	return OPENAI_COMPATIBLE_NATIVE_FAMILIES.has(family) ? 'openai' : family;
}

function resolveDeclaredNativeFamily(
	provider: LoadedProviderData
): NativeFamily | null {
	for (const candidate of [
		(provider as any)?.nativeFamily,
		(provider as any)?.nativeProtocol,
		(provider as any)?.native_family,
		(provider as any)?.native_protocol
	]) {
		if (typeof candidate !== 'string' || !candidate.trim()) continue;
		const resolved = canonicalizeNativeFamily(candidate);
		if (resolved) return resolved;
	}
	return null;
}

function resolveProviderNativeFamily(
	provider: LoadedProviderData
): NativeFamily | null {
	const declaredFamily = resolveDeclaredNativeFamily(provider);
	if (declaredFamily) return declaredFamily;
	const haystack = `${provider.id} ${provider.provider_url}`.toLowerCase();
	if (haystack.includes('openrouter')) return 'openrouter';
	if (haystack.includes('deepseek')) return 'deepseek';
	if (
		haystack.includes('xai') ||
		haystack.includes('x.ai') ||
		haystack.includes('grok')
	) {
		return 'xai';
	}
	if (haystack.includes('anthropic') || haystack.includes('claude')) {
		return 'anthropic';
	}
	if (
		haystack.includes('gemini') ||
		haystack.includes('google') ||
		haystack.includes('generativelanguage') ||
		haystack.includes('googleapis')
	) {
		return 'gemini';
	}
	return 'openai';
}

function resolveProviderAutoRoutedNativeFamily(
	provider: LoadedProviderData
): NativeFamily | null {
	return normalizeAutoRoutedNativeFamily(
		resolveProviderNativeFamily(provider)
	);
}

function inferNativeFamilyFromModelHeuristics(
	modelId: string
): NativeFamily | null {
	const normalized = String(modelId || '')
		.trim()
		.toLowerCase();
	if (!normalized) return null;
	const noNamespace = normalized.includes('/')
		? normalized.split('/').pop() || normalized
		: normalized;

	if (
		normalized.startsWith('openai/') ||
		/^gpt([\-._]|$)/.test(noNamespace) ||
		/^o[1-9]([\-._]|$)/.test(noNamespace) ||
		/^omni([\-._]|$)/.test(noNamespace) ||
		/^text-embedding([\-._]|$)/.test(noNamespace) ||
		/^whisper([\-._]|$)/.test(noNamespace) ||
		/^tts([\-._]|$)/.test(noNamespace) ||
		/^dall-e([\-._]|$)/.test(noNamespace) ||
		/^gpt-image([\-._]|$)/.test(noNamespace) ||
		/^sora([\-._]|$)/.test(noNamespace)
	) {
		return 'openai';
	}
	if (
		normalized.startsWith('anthropic/') ||
		normalized.startsWith('claude/') ||
		/^claude([\-._]|$)/.test(noNamespace)
	) {
		return 'anthropic';
	}
	if (
		normalized.startsWith('gemini/') ||
		normalized.startsWith('google/') ||
		normalized.startsWith('imagen/') ||
		/^gemini([\-._]|$)/.test(noNamespace) ||
		/^imagen([\-._]|$)/.test(noNamespace) ||
		/^nano-banana([\-._]|$)/.test(noNamespace)
	) {
		return 'gemini';
	}
	if (normalized.startsWith('openrouter/')) return 'openrouter';
	if (
		normalized.startsWith('deepseek/') ||
		/^deepseek([\-._]|$)/.test(noNamespace)
	) {
		return 'deepseek';
	}
	if (
		normalized.startsWith('xai/') ||
		normalized.startsWith('x-ai/') ||
		/^grok([\-._]|$)/.test(noNamespace)
	) {
		return 'xai';
	}

	return null;
}

function inferNativeFamilyFromSubpathHeuristics(
	subpath: string
): NativeFamily | null {
	const normalized = String(subpath || '')
		.trim()
		.toLowerCase();
	if (!normalized) return null;

	if (
		/^\/(?:v1\/)?responses(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?chat\/completions(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?completions(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?embeddings(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?audio(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?images(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?videos(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?files(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?uploads(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?vector_stores(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?assistants(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?threads(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?batches(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?fine_tuning(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?moderations(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?realtime(?:\/|$)/i.test(normalized) ||
		/^\/v1\/models(?:\/|$)/i.test(normalized)
	) {
		return 'openai';
	}

	if (
		/^\/(?:v1\/)?messages(?:\/|$)/i.test(normalized) ||
		/^\/(?:v1\/)?messages\/batches(?:\/|$)/i.test(normalized)
	) {
		return 'anthropic';
	}

	if (
		normalized.startsWith('/upload/v1beta/files') ||
		normalized.startsWith('/v1beta/models/') ||
		normalized === '/v1beta/models' ||
		normalized.startsWith('/models/') ||
		normalized === '/models'
	) {
		return 'gemini';
	}

	return null;
}

function extractMultipartBoundary(contentType: string): string | null {
	const match = String(contentType || '').match(
		/boundary=(?:"([^"]+)"|([^;]+))/i
	);
	const boundary = match?.[1] || match?.[2];
	return typeof boundary === 'string' && boundary.trim()
		? boundary.trim()
		: null;
}

function extractMultipartFormField(
	rawBody: Buffer,
	contentType: string,
	fieldName: string
): string | null {
	if (!rawBody || rawBody.length === 0) return null;
	if (
		!String(contentType || '')
			.toLowerCase()
			.includes('multipart/form-data')
	) {
		return null;
	}
	const boundary = extractMultipartBoundary(contentType);
	if (!boundary) return null;
	const rawText = rawBody.toString('latin1');
	for (const part of rawText.split(`--${boundary}`)) {
		const [rawHeaders, rawValue] = part.split(/\r?\n\r?\n/, 2);
		if (!rawHeaders || !rawValue) continue;
		if (!new RegExp(`name="${fieldName}"`, 'i').test(rawHeaders)) continue;
		return rawValue.replace(/\r?\n--$/, '').trim() || null;
	}
	return null;
}

function extractRoutingModelId(
	parsedBody: any,
	subpath: string,
	rawBody?: Buffer,
	contentType?: string
): string | null {
	if (typeof parsedBody?.model === 'string' && parsedBody.model.trim()) {
		return parsedBody.model.trim();
	}

	const multipartModelId =
		rawBody && contentType
			? extractMultipartFormField(rawBody, contentType, 'model')
			: null;
	if (multipartModelId) {
		return multipartModelId;
	}

	const directMatch = subpath.match(
		/\/models\/([^/:?]+)(?::[A-Za-z][A-Za-z0-9]*)?/i
	);
	if (directMatch?.[1]) {
		try {
			return decodeURIComponent(directMatch[1]);
		} catch {
			return directMatch[1];
		}
	}

	return null;
}

function inferNativeFamilyFromModelAndProviders(
	modelId: string,
	providers: LoadedProviders,
	options: {
		autoRoute?: boolean;
		familyHint?: NativeFamily | null;
	} = {}
): NativeFamily | null {
	const normalizedModelId = String(modelId || '').trim();
	if (!normalizedModelId) return null;

	const normalizedFamilyHint = options.autoRoute
		? normalizeAutoRoutedNativeFamily(options.familyHint)
		: options.familyHint || null;
	const resolveFamily = options.autoRoute
		? resolveProviderAutoRoutedNativeFamily
		: resolveProviderNativeFamily;

	const candidates = providers
		.filter(provider => !provider.disabled)
		.filter(
			provider =>
				typeof provider.apiKey === 'string' &&
				provider.apiKey.trim().length > 0
		)
		.filter(
			provider =>
				typeof provider.provider_url === 'string' &&
				provider.provider_url.trim().length > 0
		)
		.filter(provider => providerSupportsModel(provider, normalizedModelId))
		.map(provider => ({
			provider,
			family: resolveFamily(provider)
		}))
		.filter(
			(
				entry
			): entry is {
				provider: LoadedProviderData;
				family: NativeFamily;
			} => Boolean(entry.family)
		)
		.filter(
			entry =>
				!normalizedFamilyHint || entry.family === normalizedFamilyHint
		)
		.sort((left, right) => {
			const leftModelMatch = getProviderModelMatchStrength(
				left.provider,
				normalizedModelId
			);
			const rightModelMatch = getProviderModelMatchStrength(
				right.provider,
				normalizedModelId
			);
			if (leftModelMatch !== rightModelMatch)
				return rightModelMatch - leftModelMatch;

			const leftScore =
				typeof left.provider.provider_score === 'number' &&
				Number.isFinite(left.provider.provider_score)
					? left.provider.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider.provider_score === 'number' &&
				Number.isFinite(right.provider.provider_score)
					? right.provider.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.provider.avg_response_time === 'number' &&
				Number.isFinite(left.provider.avg_response_time)
					? left.provider.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.provider.avg_response_time === 'number' &&
				Number.isFinite(right.provider.avg_response_time)
					? right.provider.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			return left.provider.id.localeCompare(right.provider.id);
		});

	if (candidates.length > 0) {
		return candidates[0].family;
	}

	if (normalizedFamilyHint) return normalizedFamilyHint;
	const inferredFamily =
		inferNativeFamilyFromModelHeuristics(normalizedModelId);
	return options.autoRoute
		? normalizeAutoRoutedNativeFamily(inferredFamily)
		: inferredFamily;
}

function isOpenAiResponsesSubpath(subpath: string): boolean {
	return /\/responses(?:\/|$)/i.test(String(subpath || ''));
}

function isOpenAiChatCompletionsSubpath(subpath: string): boolean {
	return /\/chat\/completions(?:\/|$)/i.test(String(subpath || ''));
}

function isNativeModelsListSubpath(
	family: NativeFamily,
	subpath: string
): boolean {
	const normalized = String(subpath || '')
		.trim()
		.toLowerCase();
	if (!normalized) return false;
	if (family === 'gemini') {
		return normalized === '/models' || normalized === '/v1beta/models';
	}
	return normalized === '/models' || normalized === '/v1/models';
}

function normalizeNativeResponsesAssistantContentPart(part: any): any {
	if (!part || typeof part !== 'object') return part;
	const type = String(part.type || '').toLowerCase();
	if (
		(type === 'input_text' || type === 'text') &&
		typeof part.text === 'string'
	) {
		return { type: 'output_text', text: part.text };
	}
	if (type === 'output_text' && typeof part.text === 'string') return part;
	if (
		type === 'output_text' &&
		typeof (part as any).output_text === 'string'
	) {
		return {
			type: 'output_text',
			text: (part as any).output_text
		};
	}
	return part;
}

function hasStatefulNativeResponsesInputEntry(entry: any): boolean {
	if (!entry || typeof entry !== 'object') return false;

	const type = String(entry.type || '').toLowerCase();
	if (
		type === 'function_call' ||
		type === 'function_call_output' ||
		type === 'reasoning'
	) {
		return true;
	}

	const role =
		typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
	if (role === 'assistant' || role === 'tool' || role === 'function') {
		return true;
	}

	if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
		return true;
	}
	if (typeof entry.tool_call_id === 'string' && entry.tool_call_id.trim()) {
		return true;
	}

	const content = Array.isArray(entry.content) ? entry.content : [];
	return content.some((part: any) => {
		if (!part || typeof part !== 'object') return false;
		const partType = String(part.type || '').toLowerCase();
		if (
			partType === 'function_call' ||
			partType === 'function_call_output'
		) {
			return true;
		}
		return Array.isArray(part.tool_calls) && part.tool_calls.length > 0;
	});
}

function normalizeNativeResponsesInputForUpstream(params: {
	input: any[];
	modelId: string | null;
	previousResponseId?: string;
	tools?: any;
	toolChoice?: any;
}): {
	input: any[];
	collapsed: boolean;
	rawCount: number;
	normalizedCount: number;
} {
	const normalizedModelId = String(params.modelId || '')
		.trim()
		.toLowerCase();
	const isCodexModel = normalizedModelId.includes('codex');
	const responsesSingleTurnEnabled =
		process.env.RESPONSES_SINGLE_TURN_ONLY !== '0';
	const codexSingleTurnEnabled = process.env.CODEX_SINGLE_TURN_ONLY === '1';
	const isResponsesSingleTurnModel =
		isCodexModel ||
		normalizedModelId.includes('gpt-5') ||
		normalizedModelId.includes('gpt-4.1');
	const rawInput = Array.isArray(params.input)
		? cloneResponsesHistoryValue(params.input)
		: [];
	let normalizedInput = rawInput.map((entry: any) => {
		if (!entry || typeof entry !== 'object') return entry;
		if (!('role' in entry)) return entry;
		const role = entry.role === 'tool' ? 'assistant' : entry.role;
		const cleaned: Record<string, any> = {
			role,
			content: Array.isArray(entry.content)
				? entry.content.map(
						normalizeNativeResponsesAssistantContentPart
					)
				: entry.content
		};
		if (typeof entry.name === 'string' && entry.name.trim()) {
			cleaned.name = entry.name.trim();
		}
		if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
			cleaned.tool_calls = cloneResponsesHistoryValue(entry.tool_calls);
		}
		if (
			typeof entry.tool_call_id === 'string' &&
			entry.tool_call_id.trim()
		) {
			cleaned.tool_call_id = entry.tool_call_id.trim();
		}
		return cleaned;
	});

	const hasToolDefinitions =
		Array.isArray(params.tools) && params.tools.length > 0;
	const hasToolChoice = typeof params.toolChoice !== 'undefined';
	const hasStatefulInput =
		Boolean(params.previousResponseId) ||
		normalizedInput.some(hasStatefulNativeResponsesInputEntry);
	const canSafelyCollapseToSingleTurn =
		!hasToolDefinitions && !hasToolChoice && !hasStatefulInput;
	const userEntries = normalizedInput.filter(
		(entry: any) =>
			entry && typeof entry === 'object' && entry.role === 'user'
	);
	const shouldCollapseToSingleTurn =
		canSafelyCollapseToSingleTurn &&
		((isCodexModel && codexSingleTurnEnabled) ||
			(responsesSingleTurnEnabled &&
				isResponsesSingleTurnModel &&
				userEntries.length > 1));

	if (shouldCollapseToSingleTurn) {
		const systemEntries = normalizedInput.filter(
			(entry: any) =>
				entry &&
				typeof entry === 'object' &&
				(entry.role === 'system' || entry.role === 'developer')
		);
		const lastUserEntry = userEntries[userEntries.length - 1];
		if (lastUserEntry) {
			normalizedInput = [...systemEntries, lastUserEntry];
		}
	}

	return {
		input: normalizedInput,
		collapsed: shouldCollapseToSingleTurn,
		rawCount: rawInput.length,
		normalizedCount: normalizedInput.length
	};
}

function normalizeNativeOpenAiChatPayload(parsedBody: any): {
	payload: Record<string, any>;
	rawMessageCount: number;
	normalizedMessageCount: number;
	collapsed: boolean;
	truncated: boolean;
	modelId: string;
	maxMessagesApplied: number;
} {
	const extracted = extractMessageFromRequestBody(parsedBody);
	let normalizedMessages = filterValidChatMessages(extracted.messages);
	const rawMessageCount = Array.isArray(parsedBody?.messages)
		? parsedBody.messages.length
		: 0;
	const normalizedModelId = String(extracted.model || '')
		.trim()
		.toLowerCase();
	const isAgenticModel =
		normalizedModelId.includes('codex') ||
		normalizedModelId.includes('gpt-5') ||
		normalizedModelId.includes('gpt-4.1');
	const client = String(parsedBody?.__native_client_hint || '')
		.trim()
		.toLowerCase();
	const maxMessagesApplied =
		client === 'forge' || client === 'copilot'
			? DEFAULT_NATIVE_FORGE_CHAT_MAX_MESSAGES
			: DEFAULT_NATIVE_OPENAI_CHAT_MAX_MESSAGES;
	let truncated = false;
	if (
		isAgenticModel &&
		maxMessagesApplied > 0 &&
		normalizedMessages.length > maxMessagesApplied
	) {
		const systemMessages = normalizedMessages.filter(
			message =>
				message &&
				typeof message === 'object' &&
				(message.role === 'system' || message.role === 'developer')
		);
		const nonSystemMessages = normalizedMessages.filter(
			message =>
				message &&
				typeof message === 'object' &&
				message.role !== 'system' &&
				message.role !== 'developer'
		);
		const reservedForNonSystem =
			nonSystemMessages.length > 0
				? Math.max(
						1,
						maxMessagesApplied -
							Math.min(
								systemMessages.length,
								maxMessagesApplied - 1
							)
					)
				: 0;
		const keptSystemCount = Math.max(
			0,
			maxMessagesApplied - reservedForNonSystem
		);
		normalizedMessages = [
			...systemMessages.slice(-keptSystemCount),
			...nonSystemMessages.slice(-reservedForNonSystem)
		];
		truncated = normalizedMessages.length < rawMessageCount;
	}
	const payload: Record<string, any> = {
		...parsedBody,
		model: extracted.model,
		messages: normalizedMessages
	};
	delete payload.__native_client_hint;
	if (typeof extracted.max_tokens === 'number') {
		payload.max_tokens = extracted.max_tokens;
	}
	if (
		payload.reasoning === undefined &&
		payload.reasoning_effort !== undefined
	) {
		payload.reasoning = payload.reasoning_effort;
	}
	return {
		payload,
		rawMessageCount,
		normalizedMessageCount: normalizedMessages.length,
		collapsed: normalizedMessages.length < rawMessageCount,
		truncated,
		modelId: extracted.model,
		maxMessagesApplied
	};
}

const NATIVE_RESPONSES_HISTORY_FAMILIES = new Set<NativeFamily>(
	OPENAI_COMPATIBLE_NATIVE_FAMILIES
);

function supportsNativeResponsesHistory(
	family: NativeFamily | null | undefined
): family is NativeFamily {
	return Boolean(family && NATIVE_RESPONSES_HISTORY_FAMILIES.has(family));
}

function buildNativeResponsesOwnerScope(request: Request): string | undefined {
	const normalizedUserId =
		typeof (request as any)?.userId === 'string' &&
		(request as any).userId.trim()
			? (request as any).userId.trim()
			: '';
	if (normalizedUserId) return `user:${normalizedUserId}`;
	const normalizedApiKey =
		typeof request.apiKey === 'string' && request.apiKey.trim()
			? request.apiKey.trim()
			: '';
	if (!normalizedApiKey) return undefined;
	try {
		return `key:${crypto
			.createHmac('sha256', 'anygpt-native-owner-scope')
			.update(normalizedApiKey)
			.digest('hex')
			.slice(0, 24)}`;
	} catch {
		return `key:${normalizedApiKey.slice(0, 8)}`;
	}
}

function pruneExpiredNativeResponsesProviderPins(): void {
	const now = Date.now();
	for (const [key, cached] of nativeResponsesProviderPinMemory) {
		if (cached.expiresAt <= now) {
			nativeResponsesProviderPinMemory.delete(key);
		}
	}
}

function cacheNativeResponsesProviderPin(
	storageKey: string,
	providerId: string
): void {
	const normalizedStorageKey = String(storageKey || '').trim();
	const normalizedProviderId = String(providerId || '').trim();
	if (!normalizedStorageKey || !normalizedProviderId) return;

	if (nativeResponsesProviderPinMemory.has(normalizedStorageKey)) {
		nativeResponsesProviderPinMemory.delete(normalizedStorageKey);
	}
	nativeResponsesProviderPinMemory.set(normalizedStorageKey, {
		providerId: normalizedProviderId,
		expiresAt: Date.now() + NATIVE_RESPONSES_PROVIDER_PIN_TTL_SECONDS * 1000
	});

	while (
		nativeResponsesProviderPinMemory.size >
		NATIVE_RESPONSES_PROVIDER_PIN_MEMORY_MAX_ENTRIES
	) {
		const oldestKey = nativeResponsesProviderPinMemory.keys().next().value;
		if (!oldestKey) break;
		nativeResponsesProviderPinMemory.delete(oldestKey);
	}
}

function buildNativeResponsesProviderPinStorageKey(params: {
	ownerScope?: string;
	family: NativeFamily;
	threadKey: string;
}): string {
	const normalizedThreadKey = String(params.threadKey || '').trim();
	if (!normalizedThreadKey) return '';

	const normalizedOwnerScope =
		typeof params.ownerScope === 'string' && params.ownerScope.trim()
			? params.ownerScope.trim()
			: 'anon';
	try {
		const digest = crypto
			.createHash('sha256')
			.update(
				`${normalizedOwnerScope}|${params.family}|${normalizedThreadKey}`
			)
			.digest('hex');
		return `${NATIVE_RESPONSES_PROVIDER_PIN_REDIS_PREFIX}${digest}`;
	} catch {
		const fallback = Buffer.from(
			`${normalizedOwnerScope}|${params.family}|${normalizedThreadKey}`,
			'utf8'
		)
			.toString('base64url')
			.slice(0, 96);
		return `${NATIVE_RESPONSES_PROVIDER_PIN_REDIS_PREFIX}${fallback}`;
	}
}

function extractNativeResponsesProviderPinThreadKey(
	payload: Record<string, any> | null | undefined,
	request: Pick<Request, 'headers'>
): string {
	const candidates = [
		typeof payload?.prompt_cache_key === 'string'
			? payload.prompt_cache_key
			: '',
		typeof payload?.session_id === 'string' ? payload.session_id : '',
		typeof payload?.conversation_id === 'string'
			? payload.conversation_id
			: '',
		readTraceHeader(request, 'x-client-request-id'),
		readTraceHeader(request, 'session_id'),
		readTraceHeader(request, 'x-session-id')
	];

	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !candidate.trim()) continue;
		return candidate.trim().slice(0, 256);
	}
	return '';
}

async function loadNativeResponsesProviderPin(params: {
	ownerScope?: string;
	family: NativeFamily;
	threadKey: string;
}): Promise<string> {
	const storageKey = buildNativeResponsesProviderPinStorageKey(params);
	if (!storageKey) return '';

	pruneExpiredNativeResponsesProviderPins();
	const cached = nativeResponsesProviderPinMemory.get(storageKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.providerId;
	}
	if (cached) {
		nativeResponsesProviderPinMemory.delete(storageKey);
	}

	if (!redis) return '';
	try {
		const raw = await redis.get(storageKey);
		const providerId =
			typeof raw === 'string' && raw.trim() ? raw.trim() : '';
		if (!providerId) return '';
		cacheNativeResponsesProviderPin(storageKey, providerId);
		return providerId;
	} catch (error: any) {
		console.warn(
			`[NativeResponses] Failed to load provider pin: ${
				error?.message || error
			}`
		);
		return '';
	}
}

async function saveNativeResponsesProviderPin(params: {
	ownerScope?: string;
	family: NativeFamily;
	threadKey: string;
	providerId: string;
}): Promise<void> {
	const storageKey = buildNativeResponsesProviderPinStorageKey(params);
	const normalizedProviderId = String(params.providerId || '').trim();
	if (!storageKey || !normalizedProviderId) return;

	cacheNativeResponsesProviderPin(storageKey, normalizedProviderId);
	if (!redis) return;

	try {
		await redis.set(
			storageKey,
			normalizedProviderId,
			'EX',
			NATIVE_RESPONSES_PROVIDER_PIN_TTL_SECONDS
		);
	} catch (error: any) {
		console.warn(
			`[NativeResponses] Failed to persist provider pin: ${
				error?.message || error
			}`
		);
	}
}

function isNativeResponsesHistoryEntryUsable(
	entry: StoredResponsesHistoryEntry | null,
	ownerScope?: string
): entry is StoredResponsesHistoryEntry {
	if (!entry) return false;
	const entryOwnerScope =
		typeof (entry as any)?.owner_scope === 'string' &&
		(entry as any).owner_scope.trim()
			? (entry as any).owner_scope.trim()
			: '';
	if (ownerScope && entryOwnerScope && entryOwnerScope !== ownerScope) {
		return false;
	}
	const providerFamily = canonicalizeNativeFamily(
		typeof (entry as any)?.provider_family === 'string'
			? (entry as any).provider_family
			: ''
	);
	if (providerFamily && !supportsNativeResponsesHistory(providerFamily)) {
		return false;
	}
	return true;
}

function isNativeResponsesHistoryReplayCompatible(
	entry: StoredResponsesHistoryEntry | null,
	ownerScope?: string
): entry is StoredResponsesHistoryEntry {
	return isNativeResponsesHistoryEntryUsable(entry, ownerScope);
}

function canUseNativeResponsesUpstreamContinuation(
	entry: StoredResponsesHistoryEntry | null,
	params: {
		ownerScope?: string;
		routedFamily: NativeFamily;
		providerId: string;
	}
): entry is StoredResponsesHistoryEntry {
	if (!isNativeResponsesHistoryReplayCompatible(entry, params.ownerScope)) {
		return false;
	}
	const entryProviderFamily = canonicalizeNativeFamily(
		typeof (entry as any)?.provider_family === 'string'
			? (entry as any).provider_family
			: ''
	);
	if (!entryProviderFamily || entryProviderFamily !== params.routedFamily) {
		return false;
	}
	const entryProviderId =
		typeof (entry as any)?.provider_id === 'string' &&
		(entry as any).provider_id.trim()
			? (entry as any).provider_id.trim()
			: '';
	if (!entryProviderId || entryProviderId !== params.providerId) {
		return false;
	}
	return Boolean(
		typeof (entry as any)?.upstream_response_id === 'string' &&
		(entry as any).upstream_response_id.trim()
	);
}

function rewriteNativeResponsesResponseObject(
	responsePayload: any,
	proxyResponseId: string
): any {
	if (
		!responsePayload ||
		typeof responsePayload !== 'object' ||
		Array.isArray(responsePayload)
	) {
		return responsePayload;
	}
	const rewritten = cloneResponsesHistoryValue(responsePayload);
	rewritten.id = proxyResponseId;
	if (
		typeof rewritten.response_id === 'string' &&
		rewritten.response_id.trim()
	) {
		rewritten.response_id = proxyResponseId;
	}
	return rewritten;
}

function rewriteNativeResponsesEventPayload(
	eventPayload: any,
	proxyResponseId: string
): any {
	if (
		!eventPayload ||
		typeof eventPayload !== 'object' ||
		Array.isArray(eventPayload)
	) {
		return eventPayload;
	}
	const rewritten = cloneResponsesHistoryValue(eventPayload);
	if (
		typeof rewritten.response_id === 'string' &&
		rewritten.response_id.trim()
	) {
		rewritten.response_id = proxyResponseId;
	}
	if (rewritten.response && typeof rewritten.response === 'object') {
		rewritten.response = rewriteNativeResponsesResponseObject(
			rewritten.response,
			proxyResponseId
		);
	}
	return rewritten;
}

function serializeSseEvent(
	eventName: string | undefined,
	data: string
): string {
	let serialized = '';
	if (typeof eventName === 'string' && eventName.trim()) {
		serialized += `event: ${eventName}\n`;
	}
	for (const line of String(data ?? '').split('\n')) {
		serialized += `data: ${line}\n`;
	}
	return `${serialized}\n`;
}

function getNativeResponsesToolCallKey(rawCall: any): string | null {
	if (!rawCall || typeof rawCall !== 'object') return null;
	const callId =
		typeof rawCall?.call_id === 'string' && rawCall.call_id.trim()
			? rawCall.call_id.trim()
			: typeof rawCall?.tool_call_id === 'string' &&
				  rawCall.tool_call_id.trim()
				? rawCall.tool_call_id.trim()
				: undefined;
	if (callId) return `call:${callId}`;
	const id =
		typeof rawCall?.id === 'string' && rawCall.id.trim()
			? rawCall.id.trim()
			: undefined;
	if (id) return `id:${id}`;
	const name =
		typeof rawCall?.name === 'string' && rawCall.name.trim()
			? rawCall.name.trim()
			: rawCall?.function &&
				  typeof rawCall.function === 'object' &&
				  typeof rawCall.function.name === 'string' &&
				  rawCall.function.name.trim()
				? rawCall.function.name.trim()
				: undefined;
	return name ? `name:${name}` : null;
}

function normalizeNativeResponsesToolCall(
	rawCall: any
): Record<string, any> | null {
	if (!rawCall || typeof rawCall !== 'object') return null;
	const functionPayload =
		rawCall?.function && typeof rawCall.function === 'object'
			? rawCall.function
			: rawCall;
	const name =
		typeof functionPayload?.name === 'string' && functionPayload.name.trim()
			? functionPayload.name.trim()
			: typeof rawCall?.name === 'string' && rawCall.name.trim()
				? rawCall.name.trim()
				: '';
	if (!name) return null;
	const normalized: Record<string, any> = {
		name,
		arguments:
			typeof functionPayload?.arguments !== 'undefined'
				? cloneResponsesHistoryValue(functionPayload.arguments)
				: typeof rawCall?.arguments !== 'undefined'
					? cloneResponsesHistoryValue(rawCall.arguments)
					: '{}',
		status:
			typeof rawCall?.status === 'string' && rawCall.status.trim()
				? rawCall.status.trim()
				: 'completed'
	};
	if (typeof rawCall?.id === 'string' && rawCall.id.trim()) {
		normalized.id = rawCall.id.trim();
	}
	if (typeof rawCall?.call_id === 'string' && rawCall.call_id.trim()) {
		normalized.call_id = rawCall.call_id.trim();
	} else if (
		typeof rawCall?.tool_call_id === 'string' &&
		rawCall.tool_call_id.trim()
	) {
		normalized.call_id = rawCall.tool_call_id.trim();
	}
	return normalized;
}

function upsertNativeResponsesToolCall(
	toolCalls: Record<string, any>[],
	rawCall: any
): void {
	const normalized = normalizeNativeResponsesToolCall(rawCall);
	if (!normalized) return;
	const key = getNativeResponsesToolCallKey(normalized);
	const index = key
		? toolCalls.findIndex(
				entry => getNativeResponsesToolCallKey(entry) === key
			)
		: -1;
	if (index >= 0) {
		toolCalls[index] = {
			...toolCalls[index],
			...normalized
		};
		return;
	}
	toolCalls.push(normalized);
}

function collectNativeResponsesToolCallsFromItem(
	toolCalls: Record<string, any>[],
	item: any
): void {
	if (!item || typeof item !== 'object') return;
	if (item.type === 'function_call') {
		upsertNativeResponsesToolCall(toolCalls, item);
		return;
	}
	if (!Array.isArray(item.content)) return;
	for (const part of item.content) {
		if (
			part &&
			typeof part === 'object' &&
			part.type === 'tool_calls' &&
			Array.isArray(part.tool_calls)
		) {
			for (const toolCall of part.tool_calls) {
				upsertNativeResponsesToolCall(toolCalls, toolCall);
			}
		}
	}
}

type NativeResponsesReasoningDetails = {
	reasoningText?: string;
	reasoningId?: string;
	reasoningStatus?: string;
	reasoningSummary?: Record<string, any>[];
	reasoningEncryptedContent?: string;
	reasoningContent?: Record<string, any>[];
};

function collectNativeResponsesReasoningText(value: any): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return '';
	return value
		.map((entry: any) => {
			if (typeof entry?.text === 'string') return entry.text;
			if (typeof entry?.content === 'string') return entry.content;
			if (typeof entry?.output_text === 'string')
				return entry.output_text;
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

function extractNativeResponsesReasoningDetails(
	responsePayload: any
): NativeResponsesReasoningDetails {
	const output = Array.isArray(responsePayload?.output)
		? responsePayload.output
		: [];
	const reasoningItems = output.filter(
		(item: any) =>
			item && typeof item === 'object' && item.type === 'reasoning'
	);
	if (reasoningItems.length > 0) {
		const primaryReasoningItem = reasoningItems[reasoningItems.length - 1];
		const mergedSummary = reasoningItems.flatMap((item: any) =>
			Array.isArray(item?.summary)
				? cloneResponsesHistoryValue(item.summary)
				: []
		);
		const mergedContent = reasoningItems.flatMap((item: any) =>
			Array.isArray(item?.content)
				? cloneResponsesHistoryValue(item.content)
				: []
		);
		const reasoningText =
			collectNativeResponsesReasoningText(mergedSummary) ||
			collectNativeResponsesReasoningText(mergedContent) ||
			undefined;
		return {
			reasoningText,
			reasoningId:
				typeof primaryReasoningItem?.id === 'string' &&
				primaryReasoningItem.id.trim()
					? primaryReasoningItem.id.trim()
					: undefined,
			reasoningStatus:
				typeof primaryReasoningItem?.status === 'string' &&
				primaryReasoningItem.status.trim()
					? primaryReasoningItem.status.trim()
					: undefined,
			reasoningSummary:
				mergedSummary.length > 0 ? mergedSummary : undefined,
			reasoningEncryptedContent:
				typeof primaryReasoningItem?.encrypted_content === 'string' &&
				primaryReasoningItem.encrypted_content
					? primaryReasoningItem.encrypted_content
					: undefined,
			reasoningContent:
				mergedContent.length > 0 ? mergedContent : undefined
		};
	}

	const fallbackReasoningSummary = Array.isArray(
		responsePayload?.reasoningSummary
	)
		? cloneResponsesHistoryValue(responsePayload.reasoningSummary)
		: Array.isArray(responsePayload?.reasoning_summary)
			? cloneResponsesHistoryValue(responsePayload.reasoning_summary)
			: undefined;
	const fallbackReasoningContent = Array.isArray(
		responsePayload?.reasoningContent
	)
		? cloneResponsesHistoryValue(responsePayload.reasoningContent)
		: Array.isArray(responsePayload?.reasoning_content)
			? cloneResponsesHistoryValue(responsePayload.reasoning_content)
			: undefined;
	const fallbackReasoningEncryptedContent =
		typeof responsePayload?.reasoningEncryptedContent === 'string' &&
		responsePayload.reasoningEncryptedContent
			? responsePayload.reasoningEncryptedContent
			: typeof responsePayload?.reasoning_encrypted_content ===
						'string' && responsePayload.reasoning_encrypted_content
				? responsePayload.reasoning_encrypted_content
				: undefined;
	const fallbackReasoningTextCandidates = [
		responsePayload?.reasoningText,
		responsePayload?.reasoning_text,
		responsePayload?.reasoning,
		collectNativeResponsesReasoningText(fallbackReasoningSummary),
		collectNativeResponsesReasoningText(fallbackReasoningContent),
		responsePayload?.reasoningContent,
		responsePayload?.reasoning_content
	];
	const fallbackReasoningText = fallbackReasoningTextCandidates.find(
		(value: any) => typeof value === 'string' && value.trim()
	);
	const details: NativeResponsesReasoningDetails = {};
	if (
		typeof fallbackReasoningText === 'string' &&
		fallbackReasoningText.trim()
	) {
		details.reasoningText = fallbackReasoningText.trim();
	}
	if (fallbackReasoningSummary && fallbackReasoningSummary.length > 0) {
		details.reasoningSummary = fallbackReasoningSummary;
	}
	if (fallbackReasoningContent && fallbackReasoningContent.length > 0) {
		details.reasoningContent = fallbackReasoningContent;
	}
	if (fallbackReasoningEncryptedContent) {
		details.reasoningEncryptedContent = fallbackReasoningEncryptedContent;
	}
	return details;
}

function normalizeNativeResponsesInput(rawInput: any): any[] {
	if (Array.isArray(rawInput)) return rawInput;
	if (typeof rawInput === 'string') {
		return [{ type: 'input_text', text: rawInput }];
	}
	if (rawInput && typeof rawInput === 'object') {
		return [rawInput];
	}
	throw new Error('input must be a string, array, or object.');
}

function hasNativeResponsesCompactionItems(input: any[]): boolean {
	return Array.isArray(input)
		? input.some(
				item =>
					item &&
					typeof item === 'object' &&
					String(item.type || '').toLowerCase() === 'compaction'
			)
		: false;
}

function shouldStripNativeResponsesReasoningItems(
	client: string | undefined,
	family: NativeFamily
): boolean {
	if (family !== 'openai') return false;
	const normalized = String(client || '')
		.trim()
		.toLowerCase();
	return (
		normalized === 'forge' ||
		normalized === 'copilot' ||
		normalized === 'github'
	);
}

function stripNativeResponsesReasoningItems(input: any[]): {
	input: any[];
	strippedCount: number;
} {
	if (!Array.isArray(input) || input.length === 0) {
		return { input: Array.isArray(input) ? input : [], strippedCount: 0 };
	}
	let strippedCount = 0;
	const filtered = input.filter(item => {
		const isReasoningItem =
			item &&
			typeof item === 'object' &&
			String(item.type || '').toLowerCase() === 'reasoning';
		if (isReasoningItem) strippedCount += 1;
		return !isReasoningItem;
	});
	return {
		input: filtered,
		strippedCount
	};
}

async function persistNativeResponsesHistoryEntry(params: {
	context: NativeResponsesHistoryContext;
	responsePayload: any;
	modelId: string | null;
	request: Request;
	routedFamily: NativeFamily;
	providerId: string;
	upstreamResponseId?: string | null;
}): Promise<void> {
	const responseId =
		typeof params.context?.proxyResponseId === 'string' &&
		params.context.proxyResponseId.trim()
			? params.context.proxyResponseId.trim()
			: typeof params.responsePayload?.id === 'string' &&
				  params.responsePayload.id.trim()
				? params.responsePayload.id.trim()
				: '';
	if (!responseId) return;

	const upstreamResponseId =
		typeof params.upstreamResponseId === 'string' &&
		params.upstreamResponseId.trim()
			? params.upstreamResponseId.trim()
			: typeof params.responsePayload?.id === 'string' &&
				  params.responsePayload.id.trim() &&
				  params.responsePayload.id.trim() !== responseId
				? params.responsePayload.id.trim()
				: undefined;
	const model =
		typeof params.responsePayload?.model === 'string' &&
		params.responsePayload.model.trim()
			? params.responsePayload.model.trim()
			: typeof params.modelId === 'string' && params.modelId.trim()
				? params.modelId.trim()
				: 'unknown';
	const created =
		typeof params.responsePayload?.created === 'number' &&
		Number.isFinite(params.responsePayload.created)
			? Math.floor(params.responsePayload.created)
			: Math.floor(Date.now() / 1000);
	const outputText =
		typeof params.responsePayload?.output_text === 'string'
			? params.responsePayload.output_text
			: '';
	const toolCalls = Array.isArray(params.responsePayload?.tool_calls)
		? cloneResponsesHistoryValue(params.responsePayload.tool_calls)
		: undefined;
	const reasoningDetails = extractNativeResponsesReasoningDetails(
		params.responsePayload
	);
	const output = Array.isArray(params.responsePayload?.output)
		? cloneResponsesHistoryValue(params.responsePayload.output)
		: buildStoredResponsesHistoryOutput(
				outputText,
				toolCalls,
				reasoningDetails
			);

	const storagePlan =
		params.context.storagePlanOverride ||
		buildResponsesHistoryStoragePlan({
			previousEntry: params.context.previousEntry,
			inputDelta: params.context.inputDelta,
			fullInput: params.context.mergedInput
		});

	try {
		await saveResponsesHistoryEntry({
			id: responseId,
			model,
			output,
			output_text: outputText,
			created,
			owner_scope: params.context.ownerScope,
			provider_family: params.routedFamily,
			provider_id: params.providerId,
			upstream_response_id: upstreamResponseId,
			...storagePlan
		});
	} catch (historyError: any) {
		await logError(
			{
				message: 'Failed to persist native responses history entry.',
				errorMessage: historyError?.message || String(historyError),
				errorStack: historyError?.stack,
				responseId,
				upstreamResponseId,
				providerId: params.providerId,
				model
			},
			params.request
		);
	}
}

function estimateTokens(content: unknown): number {
	if (typeof content === 'string') return Math.ceil(content.length / 4);
	try {
		return Math.ceil(JSON.stringify(content ?? '').length / 4);
	} catch {
		return Math.ceil(String(content ?? '').length / 4);
	}
}

function normalizeJsonBody(rawBody: Buffer, contentType: string): any | null {
	if (!rawBody || rawBody.length === 0) return null;
	if (!contentType.toLowerCase().includes('application/json')) return null;
	try {
		return JSON.parse(rawBody.toString('utf8'));
	} catch {
		return null;
	}
}

function sanitizeNativeToolSchema(schema: any): any {
	const visit = (value: any): any => {
		if (Array.isArray(value)) return value.map(entry => visit(entry));
		if (!value || typeof value !== 'object') return value;

		const normalized: Record<string, any> = {};
		for (const [key, entry] of Object.entries(value)) {
			normalized[key] = visit(entry);
		}

		const rawType = normalized.type;
		const typeList = Array.isArray(rawType)
			? rawType
					.filter(entry => typeof entry === 'string')
					.map(entry => String(entry).toLowerCase())
			: typeof rawType === 'string'
				? [rawType.toLowerCase()]
				: [];
		if (
			typeList.includes('array') &&
			typeList.length > 0 &&
			typeof normalized.items === 'undefined' &&
			typeof normalized.prefixItems === 'undefined'
		) {
			normalized.items = { type: 'string' };
		}

		return normalized;
	};

	return visit(schema);
}

function sanitizeOpenAIResponseToolSchemas(payload: any): any {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload))
		return payload;
	if (!Array.isArray(payload.tools) || payload.tools.length === 0)
		return payload;

	const sanitizedTools = payload.tools.map((tool: any) => {
		if (!tool || typeof tool !== 'object' || Array.isArray(tool))
			return tool;

		const normalizedTool: Record<string, any> = { ...tool };
		if (
			typeof (tool as any).parameters === 'object' &&
			(tool as any).parameters &&
			!Array.isArray((tool as any).parameters)
		) {
			normalizedTool.parameters = sanitizeNativeToolSchema(
				(tool as any).parameters
			);
		}

		const fn = (tool as any).function;
		if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
			const normalizedFn: Record<string, any> = { ...fn };
			if (
				typeof fn.parameters === 'object' &&
				fn.parameters &&
				!Array.isArray(fn.parameters)
			) {
				normalizedFn.parameters = sanitizeNativeToolSchema(
					fn.parameters
				);
			}
			normalizedTool.function = normalizedFn;
		}

		return normalizedTool;
	});

	return {
		...payload,
		tools: sanitizedTools
	};
}

function extractNativeModelId(
	family: NativeFamily,
	subpath: string,
	parsedBody: any,
	rawBody?: Buffer,
	contentType?: string
): string | null {
	void family;
	return extractRoutingModelId(parsedBody, subpath, rawBody, contentType);
}

function getProviderModelMatchStrength(
	provider: LoadedProviderData,
	modelId: string | null
): 0 | 1 | 2 {
	if (!modelId) return 2;
	const models = provider.models || {};
	if (modelId in models) return 2;
	const tail = modelId.includes('/')
		? modelId.split('/').pop() || modelId
		: modelId;
	if (tail in models) return 1;
	return 0;
}

function providerSupportsModel(
	provider: LoadedProviderData,
	modelId: string | null
): boolean {
	return getProviderModelMatchStrength(provider, modelId) > 0;
}

function isProviderFamilyMatch(
	provider: LoadedProviderData,
	family: NativeFamily,
	options: {
		autoRoute?: boolean;
	} = {}
): boolean {
	const resolved = options.autoRoute
		? resolveProviderAutoRoutedNativeFamily(provider)
		: resolveProviderNativeFamily(provider);
	return resolved === family;
}

function selectBestNativeProvider(
	providers: LoadedProviders,
	family: NativeFamily,
	modelId: string | null,
	options: {
		autoRoute?: boolean;
	} = {}
): LoadedProviderData | null {
	const candidates = providers
		.filter(provider => !isNativeProviderCoolingDown(provider.id, modelId))
		.filter(provider => !provider.disabled)
		.filter(
			provider =>
				typeof provider.apiKey === 'string' &&
				provider.apiKey.trim().length > 0
		)
		.filter(
			provider =>
				typeof provider.provider_url === 'string' &&
				provider.provider_url.trim().length > 0
		)
		.filter(provider => isProviderFamilyMatch(provider, family, options))
		.filter(provider => providerSupportsModel(provider, modelId))
		.sort((left, right) => {
			const leftModelMatch = getProviderModelMatchStrength(left, modelId);
			const rightModelMatch = getProviderModelMatchStrength(
				right,
				modelId
			);
			if (leftModelMatch !== rightModelMatch)
				return rightModelMatch - leftModelMatch;

			const leftScore =
				typeof left.provider_score === 'number' &&
				Number.isFinite(left.provider_score)
					? left.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider_score === 'number' &&
				Number.isFinite(right.provider_score)
					? right.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.avg_response_time === 'number' &&
				Number.isFinite(left.avg_response_time)
					? left.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.avg_response_time === 'number' &&
				Number.isFinite(right.avg_response_time)
					? right.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			const leftErrors =
				typeof left.errors === 'number' && Number.isFinite(left.errors)
					? left.errors
					: Number.POSITIVE_INFINITY;
			const rightErrors =
				typeof right.errors === 'number' &&
				Number.isFinite(right.errors)
					? right.errors
					: Number.POSITIVE_INFINITY;
			return leftErrors - rightErrors;
		});

	return candidates[0] || null;
}

function listNativeProviderCandidates(
	providers: LoadedProviders,
	family: NativeFamily,
	modelId: string | null,
	options: {
		autoRoute?: boolean;
	} = {}
): LoadedProviderData[] {
	return providers
		.filter(provider => !provider.disabled)
		.filter(
			provider =>
				typeof provider.apiKey === 'string' &&
				provider.apiKey.trim().length > 0
		)
		.filter(
			provider =>
				typeof provider.provider_url === 'string' &&
				provider.provider_url.trim().length > 0
		)
		.filter(provider => isProviderFamilyMatch(provider, family, options))
		.filter(provider => providerSupportsModel(provider, modelId))
		.sort((left, right) => {
			const leftModelMatch = getProviderModelMatchStrength(left, modelId);
			const rightModelMatch = getProviderModelMatchStrength(
				right,
				modelId
			);
			if (leftModelMatch !== rightModelMatch)
				return rightModelMatch - leftModelMatch;

			const leftScore =
				typeof left.provider_score === 'number' &&
				Number.isFinite(left.provider_score)
					? left.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider_score === 'number' &&
				Number.isFinite(right.provider_score)
					? right.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.avg_response_time === 'number' &&
				Number.isFinite(left.avg_response_time)
					? left.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.avg_response_time === 'number' &&
				Number.isFinite(right.avg_response_time)
					? right.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			const leftErrors =
				typeof left.errors === 'number' && Number.isFinite(left.errors)
					? left.errors
					: Number.POSITIVE_INFINITY;
			const rightErrors =
				typeof right.errors === 'number' &&
				Number.isFinite(right.errors)
					? right.errors
					: Number.POSITIVE_INFINITY;
			return leftErrors - rightErrors;
		});
}

function findNativeProviderCandidateById(
	candidates: LoadedProviderData[],
	providerId: string | null | undefined
): LoadedProviderData | null {
	const normalizedProviderId =
		typeof providerId === 'string' && providerId.trim()
			? providerId.trim()
			: '';
	if (!normalizedProviderId) return null;
	return (
		candidates.find(provider => provider.id === normalizedProviderId) ||
		null
	);
}

function getNativeProviderCooldownKey(
	providerId: string,
	modelId: string | null
): string {
	return `${providerId}::${modelId || '*'}`;
}

function getNativeProviderCooldownRemainingMs(
	providerId: string,
	modelId: string | null
): number {
	const now = Date.now();
	for (const key of [
		getNativeProviderCooldownKey(providerId, modelId),
		getNativeProviderCooldownKey(providerId, null)
	]) {
		const expiresAt = nativeProviderCooldowns.get(key);
		if (!expiresAt) continue;
		const remaining = expiresAt - now;
		if (remaining > 0) return remaining;
		nativeProviderCooldowns.delete(key);
	}
	return 0;
}

function isNativeProviderCoolingDown(
	providerId: string,
	modelId: string | null
): boolean {
	return getNativeProviderCooldownRemainingMs(providerId, modelId) > 0;
}

function markNativeProviderCooldown(
	providerId: string,
	modelId: string | null,
	cooldownMs?: number | null
): void {
	const duration =
		Number.isFinite(cooldownMs as number) && (cooldownMs as number) > 0
			? Math.max(1_000, Math.ceil(cooldownMs as number))
			: DEFAULT_NATIVE_PROVIDER_COOLDOWN_MS;
	nativeProviderCooldowns.set(
		getNativeProviderCooldownKey(providerId, modelId),
		Date.now() + duration
	);
}

function parseRetryAfterMs(value: string | null): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.max(1_000, Math.ceil(seconds * 1000));
	}
	const retryAt = Date.parse(trimmed);
	if (Number.isFinite(retryAt)) {
		const delta = retryAt - Date.now();
		return delta > 0 ? Math.max(1_000, delta) : null;
	}
	return null;
}

function isQuotaOrRateLimitMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes('quota exceeded') ||
		normalized.includes('resource_exhausted') ||
		normalized.includes('rate limit') ||
		normalized.includes('too many requests') ||
		normalized.includes('retry in') ||
		normalized.includes('insufficient_quota') ||
		normalized.includes('billing_hard_limit_reached') ||
		normalized.includes('billing limit')
	);
}

function shouldTryNextNativeProvider(
	family: NativeFamily,
	statusCode: number,
	errorText: string
): boolean {
	if ([401, 402, 403, 408, 409, 425, 429].includes(statusCode)) return true;
	if (statusCode >= 500 && statusCode <= 599) return true;
	if (isQuotaOrRateLimitMessage(errorText)) return true;
	if (family === 'gemini') {
		const normalized = errorText.toLowerCase();
		if (
			normalized.includes('resource_exhausted') ||
			normalized.includes('service unavailable')
		) {
			return true;
		}
	}
	return false;
}

function shouldRetryNativeTransportError(error: unknown): boolean {
	const normalized = String(
		(error as any)?.message || error || ''
	).toLowerCase();
	return (
		normalized.includes('timed out') ||
		normalized.includes('timeout') ||
		normalized.includes('abort') ||
		normalized.includes('econnreset') ||
		normalized.includes('connect') ||
		normalized.includes('socket') ||
		normalized.includes('fetch failed')
	);
}

function splitProviderBase(
	family: NativeFamily,
	providerUrl: string
): { origin: string; prefixPath: string; versionPath: string } {
	const parsed = new URL(providerUrl);
	const trimmedPath = parsed.pathname.replace(/\/+$/, '');
	const match = trimmedPath.match(/^(.*?)(\/v\d+(?:beta)?)(?:\/.*)?$/i);
	const prefixPath = match?.[1] && match[1] !== '/' ? match[1] : '';
	const versionPath = match?.[2] || (family === 'gemini' ? '/v1beta' : '/v1');
	return { origin: parsed.origin, prefixPath, versionPath };
}

function joinUrlPath(...segments: string[]): string {
	const cleaned = segments
		.filter(Boolean)
		.map(segment => segment.replace(/^\/+/, '').replace(/\/+$/, ''))
		.filter(segment => segment.length > 0);
	return cleaned.length > 0 ? cleaned.join('/') : '';
}

function buildNativeUpstreamUrl(
	family: NativeFamily,
	providerUrl: string,
	subpath: string,
	queryString: string
): string {
	const { origin, prefixPath, versionPath } = splitProviderBase(
		family,
		providerUrl
	);
	const normalizedSubpath =
		typeof subpath === 'string' && subpath.trim()
			? subpath.startsWith('/')
				? subpath
				: `/${subpath}`
			: '/';
	const shouldBypassVersionPrefix =
		family === 'gemini' &&
		/^\/upload\/v\d+(?:beta)?(?:\/|$)/i.test(normalizedSubpath);

	let path = normalizedSubpath;
	if (shouldBypassVersionPrefix) {
		path = prefixPath
			? `/${joinUrlPath(prefixPath, normalizedSubpath)}`
			: normalizedSubpath;
	} else if (!/^\/v\d/i.test(normalizedSubpath)) {
		path = `/${joinUrlPath(prefixPath, versionPath, normalizedSubpath)}`;
	} else if (prefixPath) {
		path = `/${joinUrlPath(prefixPath, normalizedSubpath)}`;
	}

	const upstream = new URL(path, origin);
	if (queryString)
		upstream.search = queryString.startsWith('?')
			? queryString
			: `?${queryString}`;
	return upstream.toString();
}

function buildUpstreamHeaders(
	request: Request,
	family: NativeFamily,
	provider: LoadedProviderData,
	stream: boolean
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		const normalizedName = name.toLowerCase();
		if (
			HOP_BY_HOP_RESPONSE_HEADERS.has(normalizedName) ||
			normalizedName === 'host' ||
			normalizedName === 'authorization' ||
			normalizedName === 'x-api-key' ||
			normalizedName === 'x-goog-api-key' ||
			normalizedName === 'content-length'
		) {
			continue;
		}
		headers[name] = value;
	}

	if (stream && !headers.accept) {
		headers.accept = 'text/event-stream';
	}

	const providerKey = String(provider.apiKey || '').trim();
	if (family === 'anthropic') {
		headers['x-api-key'] = providerKey;
		headers['anthropic-version'] =
			getHeaderValue(request.headers, 'anthropic-version') ||
			process.env.ANTHROPIC_VERSION ||
			'2023-06-01';
		const anthropicBeta = getHeaderValue(request.headers, 'anthropic-beta');
		if (anthropicBeta) headers['anthropic-beta'] = anthropicBeta;
	} else if (
		family === 'openai' ||
		family === 'openrouter' ||
		family === 'deepseek' ||
		family === 'xai'
	) {
		headers.Authorization = `Bearer ${providerKey}`;
	} else {
		delete headers.Authorization;
		delete headers['x-api-key'];
		delete headers['x-goog-api-key'];
	}

	return headers;
}

function copyUpstreamHeaders(
	upstreamHeaders: Headers,
	response: Response
): void {
	for (const [name, value] of upstreamHeaders.entries()) {
		const normalized = name.toLowerCase();
		if (
			HOP_BY_HOP_RESPONSE_HEADERS.has(normalized) ||
			!SAFE_NATIVE_RESPONSE_HEADERS.has(normalized)
		) {
			continue;
		}
		response.setHeader(name, value);
	}
}

function isExplicitJsonContentType(contentType: string): boolean {
	const normalized = String(contentType || '').toLowerCase();
	return normalized.includes('/json') || normalized.includes('+json');
}

function nativeCorsMiddleware(
	request: Request,
	response: Response,
	next: () => void
): void {
	applyRouteCorsHeaders(request, response, {
		allowMethods: NATIVE_ROUTE_CORS_ALLOW_METHODS,
		exposeHeaders: NATIVE_ROUTE_CORS_EXPOSE_HEADERS
	});
	next();
}

function sendNativePreflightResponse(
	request: Request,
	response: Response
): void {
	applyRouteCorsHeaders(request, response, {
		allowMethods: NATIVE_ROUTE_CORS_ALLOW_METHODS,
		exposeHeaders: NATIVE_ROUTE_CORS_EXPOSE_HEADERS
	});
	response.status(204).end();
}

function buildSafeUpstreamErrorMessage(
	statusCode: number,
	options: { label: string; rateLimitMessage: string }
): string {
	if (statusCode === 429) return options.rateLimitMessage;
	if (statusCode === 401 || statusCode === 403) {
		return `${options.label} was rejected by the upstream provider.`;
	}
	if (statusCode === 404) {
		return `${options.label} could not be completed because the upstream resource was not found.`;
	}
	if (statusCode >= 500) {
		return `${options.label} failed at the upstream provider. Please retry later.`;
	}
	return `${options.label} failed at the upstream provider.`;
}

function buildNativeUpstreamErrorBody(
	family: NativeFamily,
	statusCode: number,
	timestamp: string
): { error: string; timestamp: string } {
	return {
		error: buildSafeUpstreamErrorMessage(statusCode, {
			label: `${family} native request`,
			rateLimitMessage:
				'Rate limit or quota exceeded at the upstream provider. Please retry later.'
		}),
		timestamp
	};
}

function extractNativeUsage(
	family: NativeFamily,
	payload: any
): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
	if (family === 'gemini') {
		return {
			promptTokens:
				typeof payload?.usageMetadata?.promptTokenCount === 'number'
					? payload.usageMetadata.promptTokenCount
					: undefined,
			completionTokens:
				typeof payload?.usageMetadata?.candidatesTokenCount === 'number'
					? payload.usageMetadata.candidatesTokenCount
					: undefined,
			totalTokens:
				typeof payload?.usageMetadata?.totalTokenCount === 'number'
					? payload.usageMetadata.totalTokenCount
					: undefined
		};
	}
	return extractUsageTokens(
		payload?.usage || payload?.message?.usage || payload
	);
}

function extractNativeSubpath(
	request: Request,
	familySegment: string
): {
	subpath: string;
	queryString: string;
} {
	const [pathOnly, queryString = ''] = String(
		request.url || request.path || ''
	).split('?');
	const prefix = `/native/${familySegment}`;
	let subpath = pathOnly.startsWith(prefix)
		? pathOnly.slice(prefix.length)
		: '/';
	if (!subpath) subpath = '/';
	return { subpath, queryString };
}

async function authAndUsageMiddleware(
	request: Request,
	response: Response,
	next: () => void
) {
	const timestamp = new Date().toISOString();
	return runAuthMiddleware(request, response, next, {
		extractApiKey: req => {
			const authorization = req.headers.authorization;
			if (
				typeof authorization === 'string' &&
				authorization.startsWith('Bearer ')
			) {
				return normalizeApiKey(authorization.slice(7));
			}
			return normalizeApiKey(
				typeof req.headers['x-api-key'] === 'string'
					? req.headers['x-api-key']
					: typeof req.headers['x-goog-api-key'] === 'string'
						? req.headers['x-goog-api-key']
						: null
			);
		},
		onMissingApiKey: async req => {
			const errDetail = { message: 'Missing API key.' };
			await logError(errDetail, req);
			return {
				status: 401,
				body: {
					error: 'Authentication or configuration failed',
					timestamp
				}
			};
		},
		onInvalidApiKey: async (req, details) => {
			const clientMessage =
				details.statusCode === 429
					? 'Rate limit or quota exceeded. Please retry later.'
					: 'Unauthorized: Invalid API key.';
			const logMsg = `Invalid API key. ${details.error || ''}`.trim();
			await logError(
				{
					message: logMsg,
					details: details.error,
					apiKey: details.apiKey
						? redactToken(details.apiKey)
						: undefined
				},
				req
			);
			return {
				status: details.statusCode,
				body: { error: clientMessage, timestamp }
			};
		},
		onInternalError: async (req, error) => {
			await logError(error, req);
			return {
				status: 500,
				body: {
					error: 'Internal Server Error',
					reference: 'Error during authentication processing.',
					timestamp
				}
			};
		}
	});
}

function rateLimitMiddleware(
	request: Request,
	response: Response,
	next: () => void
) {
	const timestamp = new Date().toISOString();
	return runRateLimitMiddleware(request, response, next, requestTimestamps, {
		onMissingContext: req => ({
			status: 500,
			body: {
				error: 'Internal Server Error',
				reference: 'Configuration error for rate limiting.',
				timestamp
			}
		}),
		onDenied: (_req, details) => ({
			status: 429,
			body: {
				error: `Rate limit exceeded: Max ${details.limit} ${details.window.toUpperCase()}.`,
				timestamp
			}
		})
	});
}

async function handleNativeProviderRequest(
	request: Request,
	response: Response
): Promise<void> {
	const timestamp = new Date().toISOString();
	try {
		const requestedFamilySegment = String(
			request.params.family || ''
		).trim();
		const autoFamilyRouting = isAutoNativeFamilySelector(
			requestedFamilySegment
		);

		const contentType = String(
			getHeaderValue(request.headers, 'content-type') || ''
		);
		const intakeFamilyLabel = requestedFamilySegment || 'unknown';
		const bodyBuffer =
			request.method === 'GET' || request.method === 'HEAD'
				? Buffer.alloc(0)
				: await withBufferedRequestBody(
						request,
						{
							label: `native:${intakeFamilyLabel}:body-read`,
							extra: {
								route: request.path,
								requestId: request.requestId,
								family: intakeFamilyLabel
							}
						},
						rawBody => Buffer.from(rawBody)
					);
		const parsedBody = normalizeJsonBody(bodyBuffer, contentType);
		const { subpath, queryString } = extractNativeSubpath(
			request,
			requestedFamilySegment
		);
		const isModelsListRoute =
			request.method === 'GET' &&
			(subpath === '/models' || subpath === '/v1/models');
		let outboundBodyBuffer = bodyBuffer;
		let nativeResponsesHistoryContext: NativeResponsesHistoryContext | null =
			null;
		let nativeChatNormalization: {
			rawMessageCount: number;
			normalizedMessageCount: number;
			collapsed: boolean;
			maxMessagesApplied: number;
		} | null = null;
		let nativeResponsesInputNormalization: {
			rawCount: number;
			normalizedCount: number;
			collapsed: boolean;
		} | null = null;
		let nativeResponsesReasoningStrippedCount = 0;
		let nativeResponsesPinnedProviderId = '';
		let nativeResponsesPinnedProviderSelected = false;
		let nativeResponsesPinnedProviderSource:
			| 'previous_response_id'
			| 'thread_key'
			| '' = '';
		let nativeResponsesOwnerScope: string | undefined;
		let nativeResponsesProviderPinKey = '';
		let nativeResponsesShouldUseProviderPin = false;
		let providers: LoadedProviders | null = null;
		let selectedProviderId = '';

		let family = canonicalizeNativeFamily(requestedFamilySegment);
		let modelId: string | null = null;
		const subpathFamilyHint = autoFamilyRouting
			? inferNativeFamilyFromSubpathHeuristics(subpath)
			: null;

		if (autoFamilyRouting) {
			if (isModelsListRoute) {
				family = 'openai';
				response.setHeader('X-AnyGPT-Routed-Family', family);
			} else {
				providers =
					await dataManager.load<LoadedProviders>('providers');
				modelId = extractRoutingModelId(
					parsedBody,
					subpath,
					bodyBuffer,
					contentType
				);
				if (modelId) {
					family = inferNativeFamilyFromModelAndProviders(
						modelId,
						providers,
						{
							autoRoute: true,
							familyHint: subpathFamilyHint
						}
					);
					if (!family) {
						response.status(404).json({
							error: `Auto native routing could not resolve a compatible native protocol for model '${modelId}'.`,
							timestamp
						});
						return;
					}
				} else if (subpathFamilyHint) {
					family = normalizeAutoRoutedNativeFamily(subpathFamilyHint);
				} else {
					response.status(400).json({
						error: "Auto native routing requires either a routable protocol path or a model id in request body.model, multipart form-data field 'model', or path '/models/{id}'.",
						timestamp
					});
					return;
				}
				if (!family) {
					response.status(404).json({
						error: 'Auto native routing could not determine a native protocol family.',
						timestamp
					});
					return;
				}
				response.setHeader('X-AnyGPT-Routed-Family', family);
			}
		} else {
			if (!family) {
				response.status(404).json({
					error: `Unsupported native provider family '${requestedFamilySegment}'.`,
					timestamp
				});
				return;
			}
			modelId = extractNativeModelId(
				family,
				subpath,
				parsedBody,
				bodyBuffer,
				contentType
			);
		}

		if (!family) {
			response.status(404).json({
				error: 'Auto native routing could not determine a native protocol family.',
				timestamp
			});
			return;
		}
		const routedFamily: NativeFamily = family;
		const traceClient = detectTraceClient(request);

		const isNativeModelsListRoute =
			request.method === 'GET' &&
			isNativeModelsListSubpath(routedFamily, subpath);

		if (isNativeModelsListRoute) {
			const payload = await buildModelsPayload(request);
			applyResponseHeaders(response, payload.headers);
			if (!payload.ok) {
				response.status(payload.statusCode).json(payload.body);
				return;
			}
			response.json(payload.body);
			return;
		}

		const isNativeResponsesRoute =
			supportsNativeResponsesHistory(routedFamily) &&
			isOpenAiResponsesSubpath(subpath);
		const isNativeOpenAiChatRoute =
			OPENAI_COMPATIBLE_NATIVE_FAMILIES.has(routedFamily) &&
			isOpenAiChatCompletionsSubpath(subpath);
		const isStrictNativeOpenAiChatRoute =
			routedFamily === 'openai' && isNativeOpenAiChatRoute;

		if (isStrictNativeOpenAiChatRoute) {
			response.setHeader(
				'X-AnyGPT-Native-Proxy-Mode',
				'strict-passthrough'
			);
			if (!NATIVE_STRICT_PASSTHROUGH) {
				response.status(409).json({
					error: 'native/openai chat requires strict passthrough. Re-enable NATIVE_STRICT_PASSTHROUGH or use /v1/chat/completions for AnyGPT-managed normalization.',
					timestamp
				});
				return;
			}
		}

		if (
			isNativeOpenAiChatRoute &&
			!NATIVE_STRICT_PASSTHROUGH &&
			parsedBody &&
			typeof parsedBody === 'object' &&
			!Array.isArray(parsedBody)
		) {
			try {
				const normalizedChat = normalizeNativeOpenAiChatPayload({
					...parsedBody,
					__native_client_hint: traceClient
				});
				nativeChatNormalization = {
					rawMessageCount: normalizedChat.rawMessageCount,
					normalizedMessageCount:
						normalizedChat.normalizedMessageCount,
					collapsed:
						normalizedChat.collapsed || normalizedChat.truncated,
					maxMessagesApplied: normalizedChat.maxMessagesApplied
				};
				modelId = normalizedChat.modelId;
				outboundBodyBuffer = Buffer.from(
					JSON.stringify(normalizedChat.payload),
					'utf8'
				);
			} catch (chatNormalizationError: any) {
				response.status(400).json({
					error:
						chatNormalizationError?.message ||
						'Bad Request: invalid chat completions payload.',
					timestamp
				});
				return;
			}
		}

		if (
			isNativeResponsesRoute &&
			parsedBody &&
			typeof parsedBody === 'object' &&
			!Array.isArray(parsedBody)
		) {
			const outboundPayload: Record<string, any> = {
				...(NATIVE_STRICT_PASSTHROUGH
					? parsedBody
					: sanitizeOpenAIResponseToolSchemas(parsedBody))
			};
			let outboundPayloadMutated = false;
			let inlineCompactionHistoryStoragePlan: ResponsesHistoryStoragePlan | null =
				null;
			let strippedReasoningCount = 0;
			const ownerScope = buildNativeResponsesOwnerScope(request);
			nativeResponsesOwnerScope = ownerScope;
			nativeResponsesShouldUseProviderPin =
				shouldStripNativeResponsesReasoningItems(
					traceClient,
					routedFamily
				);
			nativeResponsesProviderPinKey = nativeResponsesShouldUseProviderPin
				? extractNativeResponsesProviderPinThreadKey(
						outboundPayload,
						request
					)
				: '';
			const hasInput = Object.prototype.hasOwnProperty.call(
				outboundPayload,
				'input'
			);
			let inputDelta: any[] = [];
			let expandedInputDelta: any[] = [];
			if (hasInput) {
				try {
					inputDelta = normalizeNativeResponsesInput(
						outboundPayload.input
					);
					if (!NATIVE_STRICT_PASSTHROUGH) {
						const normalizedInput =
							normalizeNativeResponsesInputForUpstream({
								input: inputDelta,
								modelId,
								previousResponseId:
									typeof outboundPayload.previous_response_id ===
									'string'
										? outboundPayload.previous_response_id
										: undefined,
								tools: outboundPayload.tools,
								toolChoice: outboundPayload.tool_choice
							});
						inputDelta = normalizedInput.input;
						nativeResponsesInputNormalization = {
							rawCount: normalizedInput.rawCount,
							normalizedCount: normalizedInput.normalizedCount,
							collapsed: normalizedInput.collapsed
						};
						outboundPayload.input =
							cloneResponsesHistoryValue(inputDelta);
						outboundPayloadMutated = true;
					} else {
						nativeResponsesInputNormalization = {
							rawCount: inputDelta.length,
							normalizedCount: inputDelta.length,
							collapsed: false
						};
					}
					expandedInputDelta = cloneResponsesHistoryValue(inputDelta);
				} catch (inputError: any) {
					response.status(400).json({
						error:
							inputError?.message ||
							'Bad Request: invalid responses input payload.',
						timestamp
					});
					return;
				}
			}

			let mergedInput = cloneResponsesHistoryValue(inputDelta);
			let outboundInputForUpstream =
				cloneResponsesHistoryValue(inputDelta);
			let previousEntry: StoredResponsesHistoryEntry | null = null;
			let continuationMode: NativeResponsesHistoryContinuationMode =
				'fresh';
			const providerSelectionOptions = autoFamilyRouting
				? { autoRoute: true }
				: undefined;
			const previousResponseId =
				typeof outboundPayload.previous_response_id === 'string' &&
				outboundPayload.previous_response_id.trim()
					? outboundPayload.previous_response_id.trim()
					: '';

			if (previousResponseId) {
				const loadedPreviousEntry =
					await loadResponsesHistoryEntry(previousResponseId);
				previousEntry = isNativeResponsesHistoryReplayCompatible(
					loadedPreviousEntry,
					ownerScope
				)
					? loadedPreviousEntry
					: null;
				if (!previousEntry) {
					response.status(400).json({
						error: `Previous response with id '${previousResponseId}' not found.`,
						timestamp
					});
					return;
				}
				nativeResponsesPinnedProviderId =
					typeof previousEntry.provider_id === 'string' &&
					previousEntry.provider_id.trim()
						? previousEntry.provider_id.trim()
						: '';
				if (!selectedProviderId) {
					providers =
						providers ||
						(await dataManager.load<LoadedProviders>('providers'));
					const preselectedCandidates = listNativeProviderCandidates(
						providers,
						routedFamily,
						modelId,
						providerSelectionOptions
					);
					const pinnedProvider = findNativeProviderCandidateById(
						preselectedCandidates,
						nativeResponsesPinnedProviderId
					);
					if (pinnedProvider) {
						selectedProviderId = pinnedProvider.id;
						nativeResponsesPinnedProviderSelected = true;
						nativeResponsesPinnedProviderSource =
							'previous_response_id';
					} else {
						const preselectedAvailableCandidates =
							preselectedCandidates.filter(
								provider =>
									!isNativeProviderCoolingDown(
										provider.id,
										modelId
									)
							);
						const preselectedProvider =
							preselectedAvailableCandidates[0] ||
							selectBestNativeProvider(
								providers,
								routedFamily,
								modelId,
								providerSelectionOptions
							);
						selectedProviderId = preselectedProvider?.id || '';
					}
				}
				const canContinueUpstream =
					canUseNativeResponsesUpstreamContinuation(previousEntry, {
						ownerScope,
						routedFamily,
						providerId: selectedProviderId
					});
				if (canContinueUpstream) {
					continuationMode = 'native-upstream';
					outboundPayload.previous_response_id =
						previousEntry.upstream_response_id;
					outboundPayloadMutated = true;
				} else {
					try {
						const mergedHistory = await mergeResponsesHistoryInput(
							previousEntry,
							inputDelta
						);
						inputDelta = cloneResponsesHistoryValue(
							mergedHistory.inputDelta
						);
						mergedInput = cloneResponsesHistoryValue(
							mergedHistory.input
						);
						outboundInputForUpstream = cloneResponsesHistoryValue(
							mergedHistory.input
						);
						delete outboundPayload.previous_response_id;
						outboundPayloadMutated = true;
						continuationMode = 'replay';
					} catch (historyError: any) {
						response.status(400).json({
							error:
								historyError?.message ||
								'Stored responses history could not be reconstructed.',
							timestamp
						});
						return;
					}
				}
			}

			if (
				!nativeResponsesPinnedProviderSelected &&
				nativeResponsesShouldUseProviderPin &&
				nativeResponsesProviderPinKey
			) {
				const stickyProviderId = await loadNativeResponsesProviderPin({
					ownerScope,
					family: routedFamily,
					threadKey: nativeResponsesProviderPinKey
				});
				if (stickyProviderId) {
					providers =
						providers ||
						(await dataManager.load<LoadedProviders>('providers'));
					const stickyCandidates = listNativeProviderCandidates(
						providers,
						routedFamily,
						modelId,
						providerSelectionOptions
					);
					const stickyPinnedProvider =
						findNativeProviderCandidateById(
							stickyCandidates,
							stickyProviderId
						);
					if (stickyPinnedProvider) {
						selectedProviderId = stickyPinnedProvider.id;
						nativeResponsesPinnedProviderId =
							stickyPinnedProvider.id;
						nativeResponsesPinnedProviderSelected = true;
						nativeResponsesPinnedProviderSource = 'thread_key';
					}
				}
			}

			if (Array.isArray(outboundInputForUpstream)) {
				try {
					outboundInputForUpstream = expandResponsesCompactionItems(
						cloneResponsesHistoryValue(outboundInputForUpstream)
					);
					expandedInputDelta = expandResponsesCompactionItems(
						cloneResponsesHistoryValue(inputDelta)
					);
					if (
						hasNativeResponsesCompactionItems(mergedInput) ||
						hasNativeResponsesCompactionItems(inputDelta)
					) {
						outboundPayloadMutated = true;
					}
				} catch (compactionError: any) {
					response.status(400).json({
						error:
							compactionError?.message ||
							'Compaction input could not be decoded.',
						timestamp
					});
					return;
				}
			}
			if (
				nativeResponsesShouldUseProviderPin &&
				!nativeResponsesPinnedProviderSelected &&
				Array.isArray(outboundInputForUpstream)
			) {
				const strippedMergedInput = stripNativeResponsesReasoningItems(
					outboundInputForUpstream
				);
				const strippedDelta =
					stripNativeResponsesReasoningItems(expandedInputDelta);
				outboundInputForUpstream = strippedMergedInput.input;
				expandedInputDelta = strippedDelta.input;
				strippedReasoningCount = strippedMergedInput.strippedCount;
				if (strippedReasoningCount > 0) {
					outboundPayloadMutated = true;
				}
			}

			const inlineCompactThreshold = resolveResponsesCompactionThreshold(
				parsedBody?.context_management ??
					parsedBody?.extra_body?.context_management
			);
			if (
				inlineCompactThreshold &&
				Array.isArray(outboundInputForUpstream) &&
				outboundInputForUpstream.length > 1
			) {
				const fullInputItems = cloneResponsesHistoryValue(
					outboundInputForUpstream
				);
				const keepTailCount =
					previousResponseId &&
					Array.isArray(expandedInputDelta) &&
					expandedInputDelta.length > 0 &&
					fullInputItems.length > expandedInputDelta.length
						? expandedInputDelta.length
						: undefined;
				const keepStartIndex = findResponsesCompactionKeepStartIndex(
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
					const inlineCompactionItem = createResponsesCompactionItem({
						model: modelId || undefined,
						summary: buildResponsesCompactionSummary(compactedHead),
						sourceItemCount: compactedHead.length,
						createdAt: Math.floor(Date.now() / 1000)
					});
					const compactedInput: any[] = [
						inlineCompactionItem,
						...keptTail
					];
					outboundInputForUpstream = expandResponsesCompactionItems(
						cloneResponsesHistoryValue(compactedInput)
					);
					mergedInput = cloneResponsesHistoryValue(compactedInput);
					inlineCompactionHistoryStoragePlan = {
						input: cloneResponsesHistoryValue(compactedInput),
						replay_depth: 1,
						compacted: true
					};
					outboundPayloadMutated = true;
				}
			}
			if (
				nativeResponsesInputNormalization &&
				Array.isArray(outboundInputForUpstream)
			) {
				nativeResponsesInputNormalization = {
					...nativeResponsesInputNormalization,
					normalizedCount: outboundInputForUpstream.length,
					collapsed:
						nativeResponsesInputNormalization.collapsed ||
						Boolean(inlineCompactionHistoryStoragePlan) ||
						outboundInputForUpstream.length <
							nativeResponsesInputNormalization.rawCount
				};
			}
			if (strippedReasoningCount > 0) {
				nativeResponsesReasoningStrippedCount = strippedReasoningCount;
				nativeResponsesInputNormalization = {
					rawCount:
						nativeResponsesInputNormalization?.rawCount ||
						inputDelta.length,
					normalizedCount: Array.isArray(outboundInputForUpstream)
						? outboundInputForUpstream.length
						: nativeResponsesInputNormalization?.normalizedCount ||
							inputDelta.length,
					collapsed: true
				};
			}

			nativeResponsesHistoryContext = {
				proxyResponseId: createResponsesItemId('resp'),
				ownerScope,
				inputDelta: cloneResponsesHistoryValue(inputDelta),
				mergedInput,
				previousEntry,
				continuationMode,
				storagePlanOverride: inlineCompactionHistoryStoragePlan
			};
			if (hasInput && Array.isArray(outboundInputForUpstream)) {
				outboundPayload.input = cloneResponsesHistoryValue(
					outboundInputForUpstream
				);
			}
			if (outboundPayloadMutated) {
				outboundBodyBuffer = Buffer.from(
					JSON.stringify(outboundPayload),
					'utf8'
				);
			}
		}

		logForgeTrace('request.start', {
			requestId: request.requestId,
			method: request.method,
			path: request.path,
			url: request.url,
			requestedFamily: requestedFamilySegment,
			routedFamily,
			client: traceClient,
			userAgent: readTraceHeader(request, 'user-agent'),
			xClient: readTraceHeader(request, 'x-client'),
			internalClient: readTraceHeader(
				request,
				'x-anygpt-internal-client'
			),
			accept: readTraceHeader(request, 'accept'),
			contentType,
			modelId,
			stream:
				getHeaderValue(request.headers, 'accept')?.includes(
					'text/event-stream'
				) || parsedBody?.stream === true,
			isNativeModelsListRoute,
			isNativeResponsesRoute,
			previousResponseId:
				typeof parsedBody?.previous_response_id === 'string' &&
				parsedBody.previous_response_id.trim()
					? parsedBody.previous_response_id.trim()
					: undefined,
			inputItems: nativeResponsesHistoryContext
				? nativeResponsesHistoryContext.inputDelta.length
				: Array.isArray(parsedBody?.input)
					? parsedBody.input.length
					: undefined,
			mergedInputItems: nativeResponsesHistoryContext
				? nativeResponsesHistoryContext.mergedInput.length
				: undefined,
			responsesContinuationMode:
				nativeResponsesHistoryContext?.continuationMode,
			responsesPinnedProviderId:
				nativeResponsesPinnedProviderId || undefined,
			responsesPinnedProviderSelected:
				nativeResponsesPinnedProviderSelected || undefined,
			responsesPinnedProviderSource:
				nativeResponsesPinnedProviderSource || undefined,
			toolsCount: Array.isArray(parsedBody?.tools)
				? parsedBody.tools.length
				: undefined,
			chatMessagesRaw: nativeChatNormalization?.rawMessageCount,
			chatMessagesNormalized:
				nativeChatNormalization?.normalizedMessageCount,
			chatMessagesCollapsed: nativeChatNormalization?.collapsed,
			chatMaxMessagesApplied: nativeChatNormalization?.maxMessagesApplied,
			responsesInputRaw: nativeResponsesInputNormalization?.rawCount,
			responsesInputNormalized:
				nativeResponsesInputNormalization?.normalizedCount,
			responsesInputCollapsed:
				nativeResponsesInputNormalization?.collapsed,
			responsesReasoningStripped:
				nativeResponsesReasoningStrippedCount || undefined
		});

		if (
			modelId &&
			request.tierLimits &&
			!isModelAllowedForTier(modelId, request.tierLimits as TierData)
		) {
			const details = buildModelAccessError(
				modelId,
				request.tierLimits as TierData
			);
			response
				.status(details.statusCode)
				.json({ error: details, timestamp });
			return;
		}

		providers =
			providers || (await dataManager.load<LoadedProviders>('providers'));
		const providerSelectionOptions = autoFamilyRouting
			? { autoRoute: true }
			: undefined;
		const candidates = listNativeProviderCandidates(
			providers,
			routedFamily,
			modelId,
			providerSelectionOptions
		);
		const pinnedResponsesProvider =
			isNativeResponsesRoute && selectedProviderId
				? findNativeProviderCandidateById(
						candidates,
						selectedProviderId
					)
				: null;
		const availableCandidates = candidates.filter(
			provider => !isNativeProviderCoolingDown(provider.id, modelId)
		);
		const provider =
			pinnedResponsesProvider ||
			availableCandidates[0] ||
			selectBestNativeProvider(
				providers,
				routedFamily,
				modelId,
				providerSelectionOptions
			);
		if (!provider) {
			const autoRouteError = autoFamilyRouting
				? `Auto native routing resolved protocol '${routedFamily}'${
						subpathFamilyHint ? ` from path '${subpath}'` : ''
					}, but no active compatible provider is available${
						modelId ? ` for model '${modelId}'` : ''
					}.`
				: `No active ${routedFamily}-compatible provider is available${modelId ? ` for model '${modelId}'` : ''}.`;
			response.status(404).json({
				error: autoRouteError,
				timestamp
			});
			return;
		}
		const attemptProviders = isNativeResponsesRoute
			? [provider]
			: availableCandidates.length > 0
				? availableCandidates
				: [provider];
		selectedProviderId = provider.id;
		logForgeTrace('provider.select', {
			requestId: request.requestId,
			routedFamily,
			modelId,
			candidateCount: attemptProviders.length,
			providerId: provider.id,
			pinnedProviderId: nativeResponsesPinnedProviderId || undefined,
			pinnedProviderSelected:
				Boolean(
					pinnedResponsesProvider &&
					nativeResponsesPinnedProviderId &&
					pinnedResponsesProvider.id ===
						nativeResponsesPinnedProviderId
				) || undefined,
			pinnedProviderSource:
				nativeResponsesPinnedProviderSource || undefined
		});

		const stream =
			getHeaderValue(request.headers, 'accept')?.includes(
				'text/event-stream'
			) || parsedBody?.stream === true;
		const userApiKey = request.apiKey!;
		const queueLane = isNativeResponsesRoute ? 'responses' : 'shared';
		const requestQueue = getRequestQueueForLane(queueLane);
		const releaseQueueSlot = await requestQueue.acquire();
		let lastFailure: {
			statusCode: number;
			retryAfter: string | null;
			body: { error: string; timestamp: string };
		} | null = null;

		try {
			for (const attemptProvider of attemptProviders) {
				try {
					let upstreamUrl = buildNativeUpstreamUrl(
						routedFamily,
						String(attemptProvider.provider_url || '').trim(),
						subpath,
						queryString
					);
					if (routedFamily === 'gemini') {
						const url = new URL(upstreamUrl);
						url.searchParams.set(
							'key',
							String(attemptProvider.apiKey || '').trim()
						);
						upstreamUrl = url.toString();
					}

					const headers = buildUpstreamHeaders(
						request,
						routedFamily,
						attemptProvider,
						Boolean(stream)
					);
					const upstreamRes = await fetchWithTimeout(upstreamUrl, {
						method: request.method,
						headers,
						body:
							request.method === 'GET' ||
							request.method === 'HEAD'
								? undefined
								: new Uint8Array(outboundBodyBuffer)
					});

					if (!upstreamRes.ok) {
						const errorText = await upstreamRes.text();
						const retryAfterHeader =
							upstreamRes.headers.get('retry-after');
						const retryAfterMs =
							parseRetryAfterMs(retryAfterHeader);
						const shouldFailOver = shouldTryNextNativeProvider(
							routedFamily,
							upstreamRes.status,
							errorText
						);
						if (shouldFailOver) {
							markNativeProviderCooldown(
								attemptProvider.id,
								modelId,
								retryAfterMs
							);
						}
						await logError(
							{
								message: shouldFailOver
									? 'Native provider passthrough request failed; trying next provider.'
									: 'Native provider passthrough request failed.',
								family: routedFamily,
								providerId: attemptProvider.id,
								modelId,
								statusCode: upstreamRes.status,
								retryAfterMs,
								failover: shouldFailOver,
								upstream: errorText
							},
							request
						);
						lastFailure = {
							statusCode: upstreamRes.status,
							retryAfter: retryAfterHeader,
							body: buildNativeUpstreamErrorBody(
								routedFamily,
								upstreamRes.status,
								timestamp
							)
						};
						logForgeTrace('provider.error', {
							requestId: request.requestId,
							routedFamily,
							modelId,
							providerId: attemptProvider.id,
							statusCode: upstreamRes.status,
							retryAfterMs,
							failover: shouldFailOver,
							errorPreview:
								typeof errorText === 'string'
									? errorText.slice(0, 240)
									: ''
						});
						if (shouldFailOver) continue;

						if (retryAfterHeader) {
							response.setHeader('Retry-After', retryAfterHeader);
						}
						response
							.status(upstreamRes.status)
							.json(lastFailure.body);
						return;
					}

					response.status(upstreamRes.status);
					copyUpstreamHeaders(upstreamRes.headers, response);

					const upstreamContentType = String(
						upstreamRes.headers.get('content-type') || ''
					);
					if (upstreamContentType.includes('text/event-stream')) {
						if (!upstreamRes.body) {
							response.end();
							return;
						}
						const reader = upstreamRes.body.getReader();
						const decoder = new TextDecoder();
						let promptTokens: number | undefined;
						let completionTokens: number | undefined;
						let totalTokens: number | undefined;
						const shouldRewriteNativeResponsesIds =
							isNativeResponsesRoute &&
							nativeResponsesHistoryContext !== null;
						const proxyResponseId = shouldRewriteNativeResponsesIds
							? nativeResponsesHistoryContext?.proxyResponseId ||
								null
							: null;
						let streamUpstreamResponseId: string | null = null;
						let streamCreatedAt: number | undefined;
						let streamOutput: any[] | null = null;
						let streamOutputText = '';
						let streamToolCalls: Record<string, any>[] = [];
						const parser = createSseDataParser(
							(dataLine, eventName) => {
								if (!dataLine) return;
								if (
									shouldRewriteNativeResponsesIds &&
									dataLine === '[DONE]'
								) {
									response.write(
										serializeSseEvent(undefined, '[DONE]')
									);
									return;
								}
								let outboundDataLine = dataLine;
								try {
									const parsed = JSON.parse(dataLine);
									const normalizedPayload =
										parsed?.response &&
										typeof parsed.response === 'object'
											? parsed.response
											: parsed;
									const usage = extractNativeUsage(
										routedFamily,
										normalizedPayload
									);
									if (typeof usage.promptTokens === 'number')
										promptTokens = usage.promptTokens;
									if (
										typeof usage.completionTokens ===
										'number'
									)
										completionTokens =
											usage.completionTokens;
									if (typeof usage.totalTokens === 'number')
										totalTokens = usage.totalTokens;

									if (shouldRewriteNativeResponsesIds) {
										if (
											!streamUpstreamResponseId &&
											typeof normalizedPayload?.id ===
												'string' &&
											normalizedPayload.id.trim()
										) {
											streamUpstreamResponseId =
												normalizedPayload.id.trim();
										}
										if (
											typeof normalizedPayload?.created ===
												'number' &&
											Number.isFinite(
												normalizedPayload.created
											)
										) {
											streamCreatedAt = Math.floor(
												normalizedPayload.created
											);
										}
										if (
											Array.isArray(
												normalizedPayload?.output
											)
										) {
											streamOutput =
												cloneResponsesHistoryValue(
													normalizedPayload.output
												);
											for (const outputItem of normalizedPayload.output) {
												collectNativeResponsesToolCallsFromItem(
													streamToolCalls,
													outputItem
												);
											}
										}
										if (
											eventName ===
												'response.output_item.added' ||
											eventName ===
												'response.output_item.done'
										) {
											collectNativeResponsesToolCallsFromItem(
												streamToolCalls,
												parsed?.item
											);
										}
										if (
											eventName ===
											'response.function_call_arguments.done'
										) {
											upsertNativeResponsesToolCall(
												streamToolCalls,
												{
													id: parsed?.item_id,
													call_id: parsed?.call_id,
													name: parsed?.name,
													arguments:
														parsed?.arguments,
													status: 'completed'
												}
											);
										}
										const deltaText =
											typeof parsed?.output_text_delta ===
											'string'
												? parsed.output_text_delta
												: typeof parsed?.response
															?.output_text_delta ===
													  'string'
													? parsed.response
															.output_text_delta
													: typeof parsed?.delta ===
														  'string'
														? parsed.delta
														: typeof parsed
																	?.response
																	?.delta ===
															  'string'
															? parsed.response
																	.delta
															: '';
										if (deltaText) {
											streamOutputText += deltaText;
										}
										if (
											typeof normalizedPayload?.output_text ===
											'string'
										) {
											streamOutputText =
												normalizedPayload.output_text;
										}
										if (
											eventName ===
												'response.completed' &&
											typeof parsed?.response
												?.output_text === 'string'
										) {
											streamOutputText =
												parsed.response.output_text;
										}
										outboundDataLine = JSON.stringify(
											rewriteNativeResponsesEventPayload(
												parsed,
												proxyResponseId!
											)
										);
									}
								} catch {
									// Ignore malformed SSE while piping raw bytes.
								}
								if (shouldRewriteNativeResponsesIds) {
									response.write(
										serializeSseEvent(
											eventName,
											outboundDataLine
										)
									);
								}
							}
						);
						try {
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								if (!value || value.length === 0) continue;
								const decodedChunk = decoder.decode(value, {
									stream: true
								});
								if (shouldRewriteNativeResponsesIds) {
									if (decodedChunk) parser(decodedChunk);
									continue;
								}
								response.write(value);
								if (decodedChunk) parser(decodedChunk);
							}
							const finalChunk = decoder.decode();
							if (finalChunk) parser(finalChunk);
						} finally {
							reader.releaseLock();
						}
						if (
							typeof totalTokens === 'number' &&
							totalTokens > 0
						) {
							await updateUserTokenUsage(
								totalTokens,
								userApiKey,
								{
									modelId: modelId || undefined,
									promptTokens,
									completionTokens
								}
							);
						}
						if (
							isNativeResponsesRoute &&
							nativeResponsesShouldUseProviderPin &&
							nativeResponsesProviderPinKey
						) {
							await saveNativeResponsesProviderPin({
								ownerScope: nativeResponsesOwnerScope,
								family: routedFamily,
								threadKey: nativeResponsesProviderPinKey,
								providerId: attemptProvider.id
							});
						}
						if (
							isNativeResponsesRoute &&
							nativeResponsesHistoryContext &&
							(streamUpstreamResponseId ||
								streamOutput ||
								streamOutputText ||
								streamToolCalls.length > 0)
						) {
							await persistNativeResponsesHistoryEntry({
								context: nativeResponsesHistoryContext,
								responsePayload: {
									id: nativeResponsesHistoryContext.proxyResponseId,
									model: modelId || undefined,
									created: streamCreatedAt,
									output: streamOutput,
									output_text: streamOutputText,
									tool_calls:
										streamToolCalls.length > 0
											? cloneResponsesHistoryValue(
													streamToolCalls
												)
											: undefined
								},
								modelId,
								request,
								routedFamily: routedFamily,
								providerId: attemptProvider.id,
								upstreamResponseId: streamUpstreamResponseId
							});
							logForgeTrace('responses.stream.final', {
								requestId: request.requestId,
								routedFamily,
								modelId,
								providerId: attemptProvider.id,
								proxyResponseId:
									nativeResponsesHistoryContext.proxyResponseId,
								upstreamResponseId: streamUpstreamResponseId,
								outputTextChars: streamOutputText.length,
								outputTypes:
									summarizeTraceOutputItems(streamOutput),
								reasoningItems:
									countTraceReasoningItems(streamOutput),
								toolCallCount:
									streamToolCalls.length > 0
										? streamToolCalls.length
										: countTraceToolCalls(streamOutput),
								totalTokens
							});
						}
						if (!response.completed) response.end();
						return;
					}

					if (
						request.method === 'HEAD' ||
						upstreamRes.status === 204 ||
						upstreamRes.status === 205 ||
						upstreamRes.status === 304
					) {
						response.end();
						return;
					}

					const shouldTreatAsJson =
						isNativeResponsesRoute ||
						isExplicitJsonContentType(upstreamContentType);
					if (!shouldTreatAsJson) {
						const rawBytes = Buffer.from(
							await upstreamRes.arrayBuffer()
						);
						response.end(rawBytes);
						return;
					}

					const rawText = await upstreamRes.text();
					let parsedResponse: any = null;
					try {
						parsedResponse = rawText ? JSON.parse(rawText) : null;
					} catch {
						parsedResponse = null;
					}

					if (parsedResponse && typeof parsedResponse === 'object') {
						const usage = extractNativeUsage(
							routedFamily,
							parsedResponse
						);
						if (
							typeof usage.totalTokens === 'number' &&
							usage.totalTokens > 0
						) {
							await updateUserTokenUsage(
								usage.totalTokens,
								userApiKey,
								{
									modelId: modelId || undefined,
									promptTokens: usage.promptTokens,
									completionTokens: usage.completionTokens
								}
							);
						}
						let responsePayloadForClient = parsedResponse;
						let responseTextForClient = rawText;
						let upstreamResponseId: string | undefined;
						if (
							isNativeResponsesRoute &&
							nativeResponsesHistoryContext
						) {
							upstreamResponseId =
								typeof parsedResponse?.id === 'string' &&
								parsedResponse.id.trim()
									? parsedResponse.id.trim()
									: undefined;
							responsePayloadForClient =
								rewriteNativeResponsesResponseObject(
									parsedResponse,
									nativeResponsesHistoryContext.proxyResponseId
								);
							responseTextForClient = JSON.stringify(
								responsePayloadForClient
							);
							await persistNativeResponsesHistoryEntry({
								context: nativeResponsesHistoryContext,
								responsePayload: responsePayloadForClient,
								modelId,
								request,
								routedFamily: routedFamily,
								providerId: attemptProvider.id,
								upstreamResponseId
							});
							logForgeTrace('responses.nonstream.final', {
								requestId: request.requestId,
								routedFamily,
								modelId,
								providerId: attemptProvider.id,
								proxyResponseId:
									nativeResponsesHistoryContext.proxyResponseId,
								upstreamResponseId,
								outputTextChars:
									typeof responsePayloadForClient?.output_text ===
									'string'
										? responsePayloadForClient.output_text
												.length
										: 0,
								outputTypes: summarizeTraceOutputItems(
									responsePayloadForClient?.output
								),
								reasoningItems: countTraceReasoningItems(
									responsePayloadForClient?.output
								),
								toolCallCount: countTraceToolCalls(
									responsePayloadForClient?.output
								),
								status:
									typeof responsePayloadForClient?.status ===
									'string'
										? responsePayloadForClient.status
										: undefined
							});
						}
						if (
							isNativeResponsesRoute &&
							nativeResponsesShouldUseProviderPin &&
							nativeResponsesProviderPinKey
						) {
							await saveNativeResponsesProviderPin({
								ownerScope: nativeResponsesOwnerScope,
								family: routedFamily,
								threadKey: nativeResponsesProviderPinKey,
								providerId: attemptProvider.id
							});
						}
						if (
							!String(
								response.getHeader?.('Content-Type') || ''
							).trim()
						) {
							response.setHeader(
								'Content-Type',
								'application/json'
							);
						}
						response.end(responseTextForClient);
						return;
					}

					response.end(rawText);
					return;
				} catch (error: any) {
					if (!shouldRetryNativeTransportError(error)) throw error;
					markNativeProviderCooldown(attemptProvider.id, modelId);
					await logError(
						{
							message:
								'Native provider passthrough transport failed; trying next provider.',
							family: routedFamily,
							providerId: attemptProvider.id,
							modelId,
							errorMessage: error?.message || String(error)
						},
						request
					);
					lastFailure = {
						statusCode: 502,
						retryAfter: null,
						body: {
							error: 'Native provider request failed before the upstream response was received.',
							timestamp
						}
					};
					continue;
				}
			}

			if (lastFailure) {
				response.status(lastFailure.statusCode);
				if (lastFailure.retryAfter) {
					response.setHeader('Retry-After', lastFailure.retryAfter);
				}
				response.json(lastFailure.body);
				return;
			}

			response.status(503).json({
				error: `All ${family}-compatible providers are temporarily unavailable${modelId ? ` for model '${modelId}'` : ''}.`,
				timestamp
			});
		} finally {
			releaseQueueSlot();
		}
	} catch (error: any) {
		await logError(
			{
				message: 'Native provider passthrough request crashed.',
				errorMessage: error?.message || String(error),
				errorStack: error?.stack
			},
			request
		);
		const errorMessage = String(error?.message || '').toLowerCase();
		const backpressureRetryAfterSeconds =
			getBackpressureRetryAfterSeconds(error);
		const statusCode =
			error?.code === 'MEMORY_PRESSURE' ||
			error?.code === 'QUEUE_OVERLOADED' ||
			error?.code === 'QUEUE_WAIT_TIMEOUT'
				? 503
				: errorMessage.includes('timed out') ||
					  errorMessage.includes('abort')
					? 504
					: 502;
		if (
			typeof backpressureRetryAfterSeconds === 'number' &&
			backpressureRetryAfterSeconds > 0
		) {
			response.setHeader(
				'Retry-After',
				String(backpressureRetryAfterSeconds)
			);
		}
		response.status(statusCode).json({
			error:
				statusCode === 503
					? error?.code === 'MEMORY_PRESSURE'
						? 'Service temporarily unavailable: server is under memory pressure. Retry in a few seconds.'
						: 'Service temporarily unavailable: request queue is busy. Retry in a few seconds.'
					: statusCode === 504
						? 'Native provider request timed out.'
						: 'Native provider request failed before the upstream response was received.',
			timestamp
		});
	}
}

const nativeHandlers = [
	nativeCorsMiddleware,
	authAndUsageMiddleware,
	rateLimitMiddleware,
	async (request: Request, response: Response) => {
		await handleNativeProviderRequest(request, response);
	}
] as const;

router.options('/:family', sendNativePreflightResponse);
router.options('/:family/*', sendNativePreflightResponse);

for (const method of [
	'get',
	'post',
	'put',
	'patch',
	'delete',
	'head'
] as const) {
	router[method]('/:family', ...nativeHandlers);
	router[method]('/:family/*', ...nativeHandlers);
}

const nativeProviderRouter = router;
export default nativeProviderRouter;
