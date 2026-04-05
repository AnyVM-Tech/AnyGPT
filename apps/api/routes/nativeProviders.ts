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
import {
	updateUserTokenUsage,
	type TierData
} from '../modules/userData.js';
import {
	buildModelAccessError,
	isModelAllowedForTier
} from '../modules/planAccess.js';
import {
	dataManager,
	type LoadedProviderData,
	type LoadedProviders
} from '../modules/dataManager.js';
import { fetchWithTimeout } from '../modules/http.js';
import {
	createResponsesItemId
} from '../modules/openaiResponsesFormat.js';
import {
	createSseDataParser,
	extractUsageTokens,
	getHeaderValue
} from '../modules/openaiRequestSupport.js';
import {
	getBackpressureRetryAfterSeconds,
	withBufferedRequestBody
} from '../modules/requestIntake.js';
import { resolveProviderFamily } from '../modules/providerIdentity.js';
import { redactToken, buildSafeUpstreamErrorMessage } from '../modules/redaction.js';
import { getRequestQueueForLane } from '../modules/requestQueue.js';
import { applyResponseHeaders, buildModelsPayload } from './models.js';
import {
	type StoredResponsesHistoryEntry,
	buildResponsesHistoryStoragePlan,
	buildStoredResponsesHistoryOutput,
	cloneResponsesHistoryValue,
	loadResponsesHistoryEntry,
	mergeResponsesHistoryInput,
	saveResponsesHistoryEntry
} from '../modules/responsesHistory.js';

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
const nativeProviderCooldowns = new Map<string, number>();
const DEFAULT_NATIVE_PROVIDER_COOLDOWN_MS = (() => {
	const raw = Number(process.env.NATIVE_PROVIDER_COOLDOWN_MS ?? 60_000);
	return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.ceil(raw)) : 60_000;
})();

type NativeFamily =
	| 'openai'
	| 'anthropic'
	| 'gemini'
	| 'openrouter'
	| 'deepseek'
	| 'xai';

type NativeFamilyAlias = NativeFamily | 'claude' | 'google' | 'x-ai';

type NativeResponsesHistoryContext = {
	proxyResponseId: string;
	ownerScope?: string;
	inputDelta: any[];
	mergedInput: any[];
	previousEntry: StoredResponsesHistoryEntry | null;
};

function canonicalizeNativeFamily(raw: string): NativeFamily | null {
	const normalized = String(raw || '').trim().toLowerCase();
	if (!normalized) return null;
	if (normalized === 'openai') return 'openai';
	if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
	if (normalized === 'gemini' || normalized === 'google') return 'gemini';
	if (normalized === 'openrouter') return 'openrouter';
	if (normalized === 'deepseek') return 'deepseek';
	if (normalized === 'xai' || normalized === 'x-ai') return 'xai';
	return null;
}

function isAutoNativeFamilySelector(raw: string): boolean {
	const normalized = String(raw || '').trim().toLowerCase();
	return normalized === 'auto' || normalized === 'mutual';
}

function providerFamilyToNativeFamily(rawFamily: string): NativeFamily | null {
	const normalized = String(rawFamily || '').trim().toLowerCase();
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

function inferNativeFamilyFromModelHeuristics(modelId: string): NativeFamily | null {
	const normalized = String(modelId || '').trim().toLowerCase();
	if (!normalized) return null;
	const noNamespace = normalized.includes('/')
		? normalized.split('/').pop() || normalized
		: normalized;

	if (normalized.startsWith('openai/') || /^gpt([\-._]|$)/.test(noNamespace)) {
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

function inferNativeFamilyFromSubpathHeuristics(subpath: string): NativeFamily | null {
	const normalized = String(subpath || '').trim().toLowerCase();
	if (!normalized) return null;

	if (
		normalized === '/responses' ||
		normalized === '/v1/responses' ||
		normalized === '/chat/completions' ||
		normalized === '/v1/chat/completions'
	) {
		return 'openai';
	}

	if (normalized === '/messages' || normalized === '/v1/messages') {
		return 'anthropic';
	}

	if (normalized.startsWith('/v1beta/models/') || normalized.startsWith('/models/')) {
		return 'gemini';
	}

	return null;
}

function extractRoutingModelId(parsedBody: any, subpath: string): string | null {
	if (typeof parsedBody?.model === 'string' && parsedBody.model.trim()) {
		return parsedBody.model.trim();
	}

	const directMatch = subpath.match(/\/models\/([^/:?]+)(?::[A-Za-z][A-Za-z0-9]*)?/i);
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
	providers: LoadedProviders
): NativeFamily | null {
	const normalizedModelId = String(modelId || '').trim();
	if (!normalizedModelId) return null;

	const candidates = providers
		.filter(provider => !provider.disabled)
		.filter(provider => typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0)
		.filter(provider => typeof provider.provider_url === 'string' && provider.provider_url.trim().length > 0)
		.filter(provider => providerSupportsModel(provider, normalizedModelId))
		.map(provider => {
			const family = providerFamilyToNativeFamily(
				resolveProviderFamily({
					id: provider.id,
					provider: (provider as any)?.provider,
					type: (provider as any)?.type,
					provider_url: provider.provider_url
				})
			);
			return { provider, family };
		})
		.filter((entry): entry is { provider: LoadedProviderData; family: NativeFamily } =>
			Boolean(entry.family)
		)
		.sort((left, right) => {
			const leftScore =
				typeof left.provider.provider_score === 'number' && Number.isFinite(left.provider.provider_score)
					? left.provider.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider.provider_score === 'number' && Number.isFinite(right.provider.provider_score)
					? right.provider.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.provider.avg_response_time === 'number' && Number.isFinite(left.provider.avg_response_time)
					? left.provider.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.provider.avg_response_time === 'number' && Number.isFinite(right.provider.avg_response_time)
					? right.provider.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			return left.provider.id.localeCompare(right.provider.id);
		});

	if (candidates.length > 0) {
		return candidates[0].family;
	}

	return inferNativeFamilyFromModelHeuristics(normalizedModelId);
}

function isOpenAiResponsesSubpath(subpath: string): boolean {
	return /\/responses(?:\/|$)/i.test(String(subpath || ''));
}

const NATIVE_RESPONSES_HISTORY_FAMILIES = new Set<NativeFamily>([
	'openai',
	'openrouter',
	'deepseek',
	'xai'
]);

function supportsNativeResponsesHistory(
	family: NativeFamily | null | undefined
): family is NativeFamily {
	return Boolean(family && NATIVE_RESPONSES_HISTORY_FAMILIES.has(family));
}

function buildNativeResponsesOwnerScope(
	request: Request
): string | undefined {
	const normalizedUserId =
		typeof (request as any)?.userId === 'string' && (request as any).userId.trim()
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

function rewriteNativeResponsesResponseObject(
	responsePayload: any,
	proxyResponseId: string
): any {
	if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
		return responsePayload;
	}
	const rewritten = cloneResponsesHistoryValue(responsePayload);
	rewritten.id = proxyResponseId;
	if (typeof rewritten.response_id === 'string' && rewritten.response_id.trim()) {
		rewritten.response_id = proxyResponseId;
	}
	return rewritten;
}

function rewriteNativeResponsesEventPayload(
	eventPayload: any,
	proxyResponseId: string
): any {
	if (!eventPayload || typeof eventPayload !== 'object' || Array.isArray(eventPayload)) {
		return eventPayload;
	}
	const rewritten = cloneResponsesHistoryValue(eventPayload);
	if (typeof rewritten.response_id === 'string' && rewritten.response_id.trim()) {
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

function serializeSseEvent(eventName: string | undefined, data: string): string {
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
			: typeof rawCall?.tool_call_id === 'string' && rawCall.tool_call_id.trim()
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

function normalizeNativeResponsesToolCall(rawCall: any): Record<string, any> | null {
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
		? toolCalls.findIndex(entry => getNativeResponsesToolCallKey(entry) === key)
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
		typeof params.upstreamResponseId === 'string' && params.upstreamResponseId.trim()
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
	const output = Array.isArray(params.responsePayload?.output)
		? cloneResponsesHistoryValue(params.responsePayload.output)
		: buildStoredResponsesHistoryOutput(outputText, toolCalls);

	const storagePlan = buildResponsesHistoryStoragePlan({
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
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) return payload;

	const sanitizedTools = payload.tools.map((tool: any) => {
		if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;

		const normalizedTool: Record<string, any> = { ...tool };
		if (
			typeof (tool as any).parameters === 'object' &&
			(tool as any).parameters &&
			!Array.isArray((tool as any).parameters)
		) {
			normalizedTool.parameters = sanitizeNativeToolSchema((tool as any).parameters);
		}

		const fn = (tool as any).function;
		if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
			const normalizedFn: Record<string, any> = { ...fn };
			if (
				typeof fn.parameters === 'object' &&
				fn.parameters &&
				!Array.isArray(fn.parameters)
			) {
				normalizedFn.parameters = sanitizeNativeToolSchema(fn.parameters);
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
	parsedBody: any
): string | null {
	if (typeof parsedBody?.model === 'string' && parsedBody.model.trim()) {
		return parsedBody.model.trim();
	}

	if (family === 'gemini') {
		const match = subpath.match(/\/models\/([^/:?]+)(?::[A-Za-z][A-Za-z0-9]*)?/i);
		if (match?.[1]) {
			try {
				return decodeURIComponent(match[1]);
			} catch {
				return match[1];
			}
		}
	}

	return null;
}

function providerSupportsModel(
	provider: LoadedProviderData,
	modelId: string | null
): boolean {
	if (!modelId) return true;
	const models = provider.models || {};
	if (modelId in models) return true;
	const tail = modelId.includes('/') ? modelId.split('/').pop() || modelId : modelId;
	if (tail in models) return true;
	return false;
}

function isProviderFamilyMatch(
	provider: LoadedProviderData,
	family: NativeFamily
): boolean {
	const resolved = resolveProviderFamily({
			id: provider.id,
			provider: (provider as any)?.provider,
			type: (provider as any)?.type,
			provider_url: provider.provider_url
		});
	const mapped = providerFamilyToNativeFamily(resolved);
	return mapped === family;
}

function selectBestNativeProvider(
	providers: LoadedProviders,
	family: NativeFamily,
	modelId: string | null
): LoadedProviderData | null {
	const candidates = providers
		.filter(provider => !isNativeProviderCoolingDown(provider.id, modelId))
		.filter(provider => !provider.disabled)
		.filter(provider => typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0)
		.filter(provider => typeof provider.provider_url === 'string' && provider.provider_url.trim().length > 0)
		.filter(provider => isProviderFamilyMatch(provider, family))
		.filter(provider => providerSupportsModel(provider, modelId))
		.sort((left, right) => {
			const leftScore =
				typeof left.provider_score === 'number' && Number.isFinite(left.provider_score)
					? left.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider_score === 'number' && Number.isFinite(right.provider_score)
					? right.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.avg_response_time === 'number' && Number.isFinite(left.avg_response_time)
					? left.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.avg_response_time === 'number' && Number.isFinite(right.avg_response_time)
					? right.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			const leftErrors =
				typeof left.errors === 'number' && Number.isFinite(left.errors)
					? left.errors
					: Number.POSITIVE_INFINITY;
			const rightErrors =
				typeof right.errors === 'number' && Number.isFinite(right.errors)
					? right.errors
					: Number.POSITIVE_INFINITY;
			return leftErrors - rightErrors;
		});

	return candidates[0] || null;
}

function listNativeProviderCandidates(
	providers: LoadedProviders,
	family: NativeFamily,
	modelId: string | null
): LoadedProviderData[] {
	return providers
		.filter(provider => !provider.disabled)
		.filter(provider => typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0)
		.filter(provider => typeof provider.provider_url === 'string' && provider.provider_url.trim().length > 0)
		.filter(provider => isProviderFamilyMatch(provider, family))
		.filter(provider => providerSupportsModel(provider, modelId))
		.sort((left, right) => {
			const leftScore =
				typeof left.provider_score === 'number' && Number.isFinite(left.provider_score)
					? left.provider_score
					: Number.NEGATIVE_INFINITY;
			const rightScore =
				typeof right.provider_score === 'number' && Number.isFinite(right.provider_score)
					? right.provider_score
					: Number.NEGATIVE_INFINITY;
			if (leftScore !== rightScore) return rightScore - leftScore;

			const leftLatency =
				typeof left.avg_response_time === 'number' && Number.isFinite(left.avg_response_time)
					? left.avg_response_time
					: Number.POSITIVE_INFINITY;
			const rightLatency =
				typeof right.avg_response_time === 'number' && Number.isFinite(right.avg_response_time)
					? right.avg_response_time
					: Number.POSITIVE_INFINITY;
			if (leftLatency !== rightLatency) return leftLatency - rightLatency;

			const leftErrors =
				typeof left.errors === 'number' && Number.isFinite(left.errors)
					? left.errors
					: Number.POSITIVE_INFINITY;
			const rightErrors =
				typeof right.errors === 'number' && Number.isFinite(right.errors)
					? right.errors
					: Number.POSITIVE_INFINITY;
			return leftErrors - rightErrors;
		});
}

function getNativeProviderCooldownKey(providerId: string, modelId: string | null): string {
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
	const normalized = String((error as any)?.message || error || '').toLowerCase();
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
	const prefixPath =
		match?.[1] && match[1] !== '/' ? match[1] : '';
	const versionPath =
		match?.[2] ||
		(family === 'gemini' ? '/v1beta' : '/v1');
	return { origin: parsed.origin, prefixPath, versionPath };
}

function joinUrlPath(...segments: string[]): string {
	const cleaned = segments
		.filter(Boolean)
		.map((segment, index) => {
			if (index === 0) return segment.replace(/\/+$/, '');
			return segment.replace(/^\/+/, '').replace(/\/+$/, '');
		})
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
			? (subpath.startsWith('/') ? subpath : `/${subpath}`)
			: '/';

	let path = normalizedSubpath;
	if (!/^\/v\d/i.test(normalizedSubpath)) {
		path = `/${joinUrlPath(prefixPath, versionPath, normalizedSubpath)}`;
	} else if (prefixPath) {
		path = `/${joinUrlPath(prefixPath, normalizedSubpath)}`;
	}

	const upstream = new URL(path, origin);
	if (queryString) upstream.search = queryString.startsWith('?') ? queryString : `?${queryString}`;
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

function copyUpstreamHeaders(upstreamHeaders: Headers, response: Response): void {
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
	return extractUsageTokens(payload?.usage || payload?.message?.usage || payload);
}

function extractNativeSubpath(request: Request, familySegment: string): {
	subpath: string;
	queryString: string;
} {
	const [pathOnly, queryString = ''] = String(request.url || request.path || '').split('?');
	const prefix = `/native/${familySegment}`;
	let subpath = pathOnly.startsWith(prefix) ? pathOnly.slice(prefix.length) : '/';
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
			if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
				return normalizeApiKey(authorization.slice(7));
			}
			return normalizeApiKey(
				(typeof req.headers['x-api-key'] === 'string'
					? req.headers['x-api-key']
					: typeof req.headers['x-goog-api-key'] === 'string'
						? req.headers['x-goog-api-key']
						: null)
			);
		},
		onMissingApiKey: async req => {
			const errDetail = { message: 'Missing API key.' };
			await logError(errDetail, req);
			return {
				status: 401,
				body: { error: 'Authentication or configuration failed', timestamp }
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
					apiKey: details.apiKey ? redactToken(details.apiKey) : undefined
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
		const requestedFamilySegment = String(request.params.family || '').trim();
		const autoFamilyRouting = isAutoNativeFamilySelector(requestedFamilySegment);

		const contentType = String(getHeaderValue(request.headers, 'content-type') || '');
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
		const { subpath, queryString } = extractNativeSubpath(request, requestedFamilySegment);
		const isModelsListRoute =
			request.method === 'GET' && (subpath === '/models' || subpath === '/v1/models');
		let outboundBodyBuffer = bodyBuffer;
		let nativeResponsesHistoryContext: NativeResponsesHistoryContext | null = null;

		let family = canonicalizeNativeFamily(requestedFamilySegment);
		let modelId: string | null = null;

		if (autoFamilyRouting) {
			if (isModelsListRoute) {
				family = 'openai';
				response.setHeader('X-AnyGPT-Routed-Family', family);
			} else {
				modelId = extractRoutingModelId(parsedBody, subpath);
				if (modelId) {
					const providersForFamilyResolution =
						await dataManager.load<LoadedProviders>('providers');
					family = inferNativeFamilyFromModelAndProviders(
						modelId,
						providersForFamilyResolution
					);
					if (!family) {
						response.status(404).json({
							error: `Auto native routing could not resolve provider family for model '${modelId}'.`,
							timestamp
						});
						return;
					}
				} else {
					family = inferNativeFamilyFromSubpathHeuristics(subpath);
					if (!family) {
						response.status(400).json({
							error:
								"Auto native routing requires a model id in request body.model or path '/models/{id}'.",
							timestamp
						});
						return;
					}
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
			modelId = extractNativeModelId(family, subpath, parsedBody);
		}

		if (
			family === 'openai' &&
			request.method === 'GET' &&
			(subpath === '/models' || subpath === '/v1/models')
		) {
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
			supportsNativeResponsesHistory(family) && isOpenAiResponsesSubpath(subpath);

		if (
			isNativeResponsesRoute &&
			parsedBody &&
			typeof parsedBody === 'object' &&
			!Array.isArray(parsedBody)
		) {
			const sanitizedPayload = sanitizeOpenAIResponseToolSchemas(parsedBody);
			const outboundPayload: Record<string, any> = { ...sanitizedPayload };
			const ownerScope = buildNativeResponsesOwnerScope(request);
			const hasInput = Object.prototype.hasOwnProperty.call(outboundPayload, 'input');
			let inputDelta: any[] = [];
			if (hasInput) {
				try {
					inputDelta = normalizeNativeResponsesInput(outboundPayload.input);
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
			let previousEntry: StoredResponsesHistoryEntry | null = null;
			const previousResponseId =
				typeof outboundPayload.previous_response_id === 'string' &&
				outboundPayload.previous_response_id.trim()
					? outboundPayload.previous_response_id.trim()
					: '';

			if (previousResponseId) {
				const loadedPreviousEntry = await loadResponsesHistoryEntry(previousResponseId);
				previousEntry = isNativeResponsesHistoryEntryUsable(
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
				try {
					const mergedHistory = await mergeResponsesHistoryInput(
						previousEntry,
						inputDelta
					);
					mergedInput = cloneResponsesHistoryValue(mergedHistory.input);
					outboundPayload.input = mergedHistory.input;
					delete outboundPayload.previous_response_id;
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

			nativeResponsesHistoryContext = {
				proxyResponseId: createResponsesItemId('resp'),
				ownerScope,
				inputDelta: cloneResponsesHistoryValue(inputDelta),
				mergedInput,
				previousEntry
			};
			outboundBodyBuffer = Buffer.from(JSON.stringify(outboundPayload), 'utf8');
		}

		if (
			modelId &&
			request.tierLimits &&
			!isModelAllowedForTier(modelId, request.tierLimits as TierData)
		) {
			const details = buildModelAccessError(modelId, request.tierLimits as TierData);
			response.status(details.statusCode).json({ error: details, timestamp });
			return;
		}

		const providers = await dataManager.load<LoadedProviders>('providers');
		const candidates = listNativeProviderCandidates(providers, family, modelId);
		const availableCandidates = candidates.filter(
			provider => !isNativeProviderCoolingDown(provider.id, modelId)
		);
		const provider = availableCandidates[0] || selectBestNativeProvider(providers, family, modelId);
		if (!provider) {
			response.status(404).json({
				error: `No active ${family}-compatible provider is available${modelId ? ` for model '${modelId}'` : ''}.`,
				timestamp
			});
			return;
		}
		const attemptProviders = availableCandidates.length > 0 ? availableCandidates : [provider];

		const stream =
			getHeaderValue(request.headers, 'accept')?.includes('text/event-stream') ||
			parsedBody?.stream === true;
		const userApiKey = request.apiKey!;
		const queueLane = isNativeResponsesRoute ? 'responses' : 'shared';
		const requestQueue = getRequestQueueForLane(queueLane);
		const releaseQueueSlot = await requestQueue.acquire();
		let lastFailure:
			| {
					statusCode: number;
					retryAfter: string | null;
					body: { error: string; timestamp: string };
			  }
			| null = null;

		try {
			for (const attemptProvider of attemptProviders) {
				try {
				let upstreamUrl = buildNativeUpstreamUrl(
					family,
					String(attemptProvider.provider_url || '').trim(),
					subpath,
					queryString
				);
				if (family === 'gemini') {
					const url = new URL(upstreamUrl);
					url.searchParams.set('key', String(attemptProvider.apiKey || '').trim());
					upstreamUrl = url.toString();
				}

				const headers = buildUpstreamHeaders(
					request,
					family,
					attemptProvider,
					Boolean(stream)
				);
				const upstreamRes = await fetchWithTimeout(upstreamUrl, {
					method: request.method,
					headers,
					body:
						request.method === 'GET' || request.method === 'HEAD'
							? undefined
							: new Uint8Array(outboundBodyBuffer)
				});

				if (!upstreamRes.ok) {
					const errorText = await upstreamRes.text();
					const retryAfterHeader = upstreamRes.headers.get('retry-after');
					const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
					const shouldFailOver = shouldTryNextNativeProvider(
						family,
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
							family,
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
							family,
							upstreamRes.status,
							timestamp
						)
					};
					if (shouldFailOver) continue;

					if (retryAfterHeader) {
						response.setHeader('Retry-After', retryAfterHeader);
					}
					response.status(upstreamRes.status).json(lastFailure.body);
					return;
				}

				response.status(upstreamRes.status);
				copyUpstreamHeaders(upstreamRes.headers, response);

				const upstreamContentType = String(upstreamRes.headers.get('content-type') || '');
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
						isNativeResponsesRoute && nativeResponsesHistoryContext !== null;
					const proxyResponseId = shouldRewriteNativeResponsesIds
						? nativeResponsesHistoryContext?.proxyResponseId || null
						: null;
					let streamUpstreamResponseId: string | null = null;
					let streamCreatedAt: number | undefined;
					let streamOutput: any[] | null = null;
					let streamOutputText = '';
					let streamToolCalls: Record<string, any>[] = [];
					const parser = createSseDataParser((dataLine, eventName) => {
						if (!dataLine) return;
						if (shouldRewriteNativeResponsesIds && dataLine === '[DONE]') {
							response.write(serializeSseEvent(undefined, '[DONE]'));
							return;
						}
						let outboundDataLine = dataLine;
						try {
							const parsed = JSON.parse(dataLine);
							const normalizedPayload =
								parsed?.response && typeof parsed.response === 'object'
									? parsed.response
									: parsed;
							const usage = extractNativeUsage(family, normalizedPayload);
							if (typeof usage.promptTokens === 'number') promptTokens = usage.promptTokens;
							if (typeof usage.completionTokens === 'number') completionTokens = usage.completionTokens;
							if (typeof usage.totalTokens === 'number') totalTokens = usage.totalTokens;

							if (shouldRewriteNativeResponsesIds) {
								if (
									!streamUpstreamResponseId &&
									typeof normalizedPayload?.id === 'string' &&
									normalizedPayload.id.trim()
								) {
									streamUpstreamResponseId = normalizedPayload.id.trim();
								}
								if (
									typeof normalizedPayload?.created === 'number' &&
									Number.isFinite(normalizedPayload.created)
								) {
									streamCreatedAt = Math.floor(normalizedPayload.created);
								}
								if (Array.isArray(normalizedPayload?.output)) {
									streamOutput = cloneResponsesHistoryValue(normalizedPayload.output);
									for (const outputItem of normalizedPayload.output) {
										collectNativeResponsesToolCallsFromItem(streamToolCalls, outputItem);
									}
								}
								if (
									eventName === 'response.output_item.added' ||
									eventName === 'response.output_item.done'
								) {
									collectNativeResponsesToolCallsFromItem(
										streamToolCalls,
										parsed?.item
									);
								}
								if (eventName === 'response.function_call_arguments.done') {
									upsertNativeResponsesToolCall(streamToolCalls, {
										id: parsed?.item_id,
										call_id: parsed?.call_id,
										name: parsed?.name,
										arguments: parsed?.arguments,
										status: 'completed'
									});
								}
								const deltaText =
									typeof parsed?.output_text_delta === 'string'
										? parsed.output_text_delta
										: typeof parsed?.response?.output_text_delta === 'string'
											? parsed.response.output_text_delta
											: typeof parsed?.delta === 'string'
												? parsed.delta
												: typeof parsed?.response?.delta === 'string'
													? parsed.response.delta
													: '';
								if (deltaText) {
									streamOutputText += deltaText;
								}
								if (
									typeof normalizedPayload?.output_text === 'string'
								) {
									streamOutputText = normalizedPayload.output_text;
								}
								if (
									eventName === 'response.completed' &&
									typeof parsed?.response?.output_text === 'string'
								) {
									streamOutputText = parsed.response.output_text;
								}
								outboundDataLine = JSON.stringify(
									rewriteNativeResponsesEventPayload(parsed, proxyResponseId!)
								);
							}
						} catch {
							// Ignore malformed SSE while piping raw bytes.
						}
						if (shouldRewriteNativeResponsesIds) {
							response.write(serializeSseEvent(eventName, outboundDataLine));
						}
					});
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							if (!value || value.length === 0) continue;
							const decodedChunk = decoder.decode(value, { stream: true });
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
					if (typeof totalTokens === 'number' && totalTokens > 0) {
						await updateUserTokenUsage(totalTokens, userApiKey, {
							modelId: modelId || undefined,
							promptTokens,
							completionTokens
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
										? cloneResponsesHistoryValue(streamToolCalls)
										: undefined
							},
							modelId,
							request,
							routedFamily: family,
							providerId: attemptProvider.id,
							upstreamResponseId: streamUpstreamResponseId
						});
					}
					if (!response.completed) response.end();
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
					const usage = extractNativeUsage(family, parsedResponse);
					if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) {
						await updateUserTokenUsage(usage.totalTokens, userApiKey, {
							modelId: modelId || undefined,
							promptTokens: usage.promptTokens,
							completionTokens: usage.completionTokens
						});
					}
					let responsePayloadForClient = parsedResponse;
					let responseTextForClient = rawText;
					let upstreamResponseId: string | undefined;
					if (isNativeResponsesRoute && nativeResponsesHistoryContext) {
						upstreamResponseId =
							typeof parsedResponse?.id === 'string' && parsedResponse.id.trim()
								? parsedResponse.id.trim()
								: undefined;
						responsePayloadForClient = rewriteNativeResponsesResponseObject(
							parsedResponse,
							nativeResponsesHistoryContext.proxyResponseId
						);
						responseTextForClient = JSON.stringify(responsePayloadForClient);
						await persistNativeResponsesHistoryEntry({
							context: nativeResponsesHistoryContext,
							responsePayload: responsePayloadForClient,
							modelId,
							request,
							routedFamily: family,
							providerId: attemptProvider.id,
							upstreamResponseId
						});
					}
					if (!String(response.getHeader?.('Content-Type') || '').trim()) {
						response.setHeader('Content-Type', 'application/json');
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
							message: 'Native provider passthrough transport failed; trying next provider.',
							family,
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
				: errorMessage.includes('timed out') || errorMessage.includes('abort')
					? 504
					: 502;
		if (
			typeof backpressureRetryAfterSeconds === 'number' &&
			backpressureRetryAfterSeconds > 0
		) {
			response.setHeader('Retry-After', String(backpressureRetryAfterSeconds));
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

const nativeHandlers = [authAndUsageMiddleware, rateLimitMiddleware, async (
	request: Request,
	response: Response
) => {
	await handleNativeProviderRequest(request, response);
}] as const;

for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const) {
	router[method]('/:family', ...nativeHandlers);
	router[method]('/:family/*', ...nativeHandlers);
}

const nativeProviderRouter = router;
export default nativeProviderRouter;
