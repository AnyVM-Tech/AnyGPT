import crypto from 'node:crypto';

import { readEnvNumber } from './tokenEstimation.js';

export type ResponsesCompactionPayload = {
	v: 1;
	model?: string;
	summary: string;
	created_at: number;
	source_item_count: number;
};

function isBoundaryHistoryItem(item: any): boolean {
	if (!item || typeof item !== 'object') return false;
	const type = String(item.type || '').toLowerCase();
	if (
		type === 'function_call' ||
		type === 'function_call_output' ||
		type === 'reasoning' ||
		type === 'compaction' ||
		type === 'computer_call' ||
		type === 'mcp_call' ||
		type === 'mcp_list_tools' ||
		type === 'mcp_approval_request' ||
		type === 'tool_search_call' ||
		type === 'tool_search_output' ||
		type === 'web_search_call' ||
		type === 'file_search_call'
	) {
		return true;
	}
	const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
	return (
		role === 'assistant' ||
		role === 'tool' ||
		role === 'function'
	);
}

const RESPONSES_COMPACTION_SUMMARY_MAX_CHARS = Math.max(
	1024,
	readEnvNumber('RESPONSES_COMPACTION_SUMMARY_MAX_CHARS', 24_000)
);
const RESPONSES_COMPACTION_LINE_MAX_CHARS = Math.max(
	128,
	readEnvNumber('RESPONSES_COMPACTION_LINE_MAX_CHARS', 1_200)
);

function base64UrlEncode(value: Buffer): string {
	return value
		.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function base64UrlDecode(value: string): Buffer {
	const padded = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64');
}

function getResponsesCompactionSecret(): string {
	const explicit = process.env.RESPONSES_COMPACTION_SECRET?.trim();
	if (explicit) return explicit;
	const shared = process.env.INTERACTIONS_SIGNING_SECRET?.trim();
	if (shared) return shared;
	return 'anygpt-development-responses-compaction-secret';
}

function getResponsesCompactionKey(): Buffer {
	return crypto
		.createHash('sha256')
		.update(getResponsesCompactionSecret(), 'utf8')
		.digest();
}

function createCompactionId(): string {
	try {
		return `cmp_${crypto.randomUUID().replace(/-/g, '')}`;
	} catch {
		return `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	}
}

function normalizeInlineText(value: unknown): string {
	const text = typeof value === 'string' ? value : String(value ?? '');
	return text.replace(/\s+/g, ' ').trim();
}

function truncateLine(value: unknown): string {
	const normalized = normalizeInlineText(value);
	if (!normalized) return '';
	if (normalized.length <= RESPONSES_COMPACTION_LINE_MAX_CHARS) {
		return normalized;
	}
	return `${normalized.slice(0, RESPONSES_COMPACTION_LINE_MAX_CHARS - 24)}...[truncated]`;
}

function stringifyStructuredValue(value: unknown): string {
	if (typeof value === 'string') return truncateLine(value);
	try {
		return truncateLine(JSON.stringify(value));
	} catch {
		return truncateLine(String(value ?? ''));
	}
}

function extractBlockText(block: any): string[] {
	if (!block || typeof block !== 'object') return [];

	const type = String(block.type || '').toLowerCase();
	if ((type === 'input_text' || type === 'text' || type === 'output_text') && typeof block.text === 'string') {
		const text = truncateLine(block.text);
		return text ? [text] : [];
	}
	if (type === 'refusal' && typeof block.refusal === 'string') {
		const text = truncateLine(block.refusal);
		return text ? [`Refusal: ${text}`] : [];
	}
	if (type === 'input_image' || type === 'image_url') return ['[image input]'];
	if (type === 'input_file' || type === 'file') return ['[file input]'];
	if (type === 'input_audio' || type === 'audio') return ['[audio input]'];
	if (type === 'tool_calls' && Array.isArray(block.tool_calls)) {
		const names = block.tool_calls
			.map((toolCall: any) => toolCall?.function?.name || toolCall?.name)
			.filter((name: unknown) => typeof name === 'string' && name.trim())
			.map((name: string) => name.trim());
		return names.length > 0 ? [`Tool calls: ${names.join(', ')}`] : ['[tool calls]'];
	}
	return [];
}

function extractItemSummaryLines(item: any): string[] {
	if (typeof item === 'string') {
		const text = truncateLine(item);
		return text ? [`USER: ${text}`] : [];
	}
	if (!item || typeof item !== 'object') return [];

	const type = String(item.type || '').toLowerCase();
	if (type === 'compaction') {
		try {
			const payload = decodeResponsesCompactionPayload(item.encrypted_content);
			const text = truncateLine(payload.summary);
			return text ? [`PRIOR COMPACTION: ${text}`] : [];
		} catch {
			return ['[prior compaction item]'];
		}
	}

	if (type === 'message' || typeof item.role === 'string') {
		const role = typeof item.role === 'string' ? item.role.toUpperCase() : 'USER';
		if (typeof item.content === 'string') {
			const text = truncateLine(item.content);
			return text ? [`${role}: ${text}`] : [];
		}
		if (Array.isArray(item.content)) {
			const parts = item.content.flatMap((block: any) => extractBlockText(block));
			if (parts.length > 0)
				return parts.map((part: string) => `${role}: ${part}`);
		}
		return [];
	}

	if (type === 'function_call') {
		const name =
			typeof item.name === 'string' && item.name.trim()
				? item.name.trim()
				: typeof item.function?.name === 'string' && item.function.name.trim()
					? item.function.name.trim()
					: 'unknown_function';
		return [
			`ASSISTANT FUNCTION CALL ${name}: ${stringifyStructuredValue(
				item.arguments ?? item.function?.arguments ?? item.args ?? item.parameters
			)}`
		];
	}

	if (type === 'function_call_output') {
		return [
			`FUNCTION OUTPUT ${item.call_id || item.id || ''}: ${stringifyStructuredValue(
				item.output
			)}`
		];
	}

	if (type === 'reasoning') {
		const summary = Array.isArray(item.summary)
			? item.summary
					.map((entry: any) => entry?.text)
					.filter((text: unknown) => typeof text === 'string' && text.trim())
					.join(' ')
			: typeof item.summary === 'string'
				? item.summary
				: '';
		const text = truncateLine(summary);
		return text ? [`REASONING: ${text}`] : [];
	}

	return [stringifyStructuredValue(item)];
}

export function buildResponsesCompactionSummary(input: any[]): string {
	const items = Array.isArray(input) ? input : [input];
	const lines = items.flatMap((item) => extractItemSummaryLines(item)).filter(Boolean);

	if (lines.length === 0) {
		return 'Compacted conversation state: no prior textual context was available.';
	}

	const headCount = Math.min(6, lines.length);
	const head = lines.slice(0, headCount);
	const tailCandidates = lines.slice(headCount);
	const tailCount = Math.min(48, tailCandidates.length);
	const tail = tailCandidates.slice(-tailCount);
	const omitted = Math.max(0, tailCandidates.length - tail.length);

	const sections: string[] = [
		'Compacted conversation state. Preserve goals, constraints, decisions, tool results, and unresolved work.',
	];
	if (head.length > 0) {
		sections.push('Earlier context:');
		sections.push(...head);
	}
	if (omitted > 0) {
		sections.push(`[${omitted} middle item(s) omitted for brevity.]`);
	}
	if (tail.length > 0) {
		sections.push('Recent context:');
		sections.push(...tail);
	}

	let summary = sections.join('\n');
	if (summary.length > RESPONSES_COMPACTION_SUMMARY_MAX_CHARS) {
		const half = Math.floor(
			(RESPONSES_COMPACTION_SUMMARY_MAX_CHARS - 32) / 2
		);
		summary = `${summary.slice(0, half)}\n...[summary truncated]...\n${summary.slice(-half)}`;
	}
	return summary;
}

export function estimateResponsesCompactionTokens(value: unknown): number {
	try {
		return Math.max(0, Math.ceil(JSON.stringify(value).length / 4));
	} catch {
		return Math.max(0, Math.ceil(String(value ?? '').length / 4));
	}
}

export function resolveResponsesCompactionThreshold(
	contextManagement: any
): number | null {
	const source =
		Array.isArray(contextManagement) && contextManagement.length > 0
			? contextManagement[0]
			: contextManagement;
	const raw = source?.compact_threshold;
	if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	if (typeof raw === 'string' && raw.trim()) {
		const parsed = Number(raw.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return null;
}

export function findResponsesCompactionKeepStartIndex(
	input: any[],
	preferredTailCount?: number
): number {
	if (!Array.isArray(input) || input.length === 0) return 0;

	if (
		typeof preferredTailCount === 'number' &&
		Number.isFinite(preferredTailCount) &&
		preferredTailCount > 0 &&
		preferredTailCount < input.length
	) {
		return input.length - Math.floor(preferredTailCount);
	}

	for (let index = input.length - 1; index >= 0; index -= 1) {
		if (isBoundaryHistoryItem(input[index])) {
			return Math.min(input.length, index + 1);
		}
	}

	return Math.max(0, input.length - 1);
}

export function encodeResponsesCompactionPayload(
	payload: ResponsesCompactionPayload
): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(
		'aes-256-gcm',
		getResponsesCompactionKey(),
		iv
	);
	const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [iv, ciphertext, tag].map(base64UrlEncode).join('.');
}

export function decodeResponsesCompactionPayload(
	encryptedContent: string
): ResponsesCompactionPayload {
	const [ivPart, ciphertextPart, tagPart] = String(
		encryptedContent || ''
	).split('.');
	if (!ivPart || !ciphertextPart || !tagPart) {
		throw new Error('Invalid compaction token format.');
	}
	const decipher = crypto.createDecipheriv(
		'aes-256-gcm',
		getResponsesCompactionKey(),
		base64UrlDecode(ivPart)
	);
	decipher.setAuthTag(base64UrlDecode(tagPart));
	const plaintext = Buffer.concat([
		decipher.update(base64UrlDecode(ciphertextPart)),
		decipher.final()
	]).toString('utf8');
	const parsed = JSON.parse(plaintext) as ResponsesCompactionPayload;
	if (parsed?.v !== 1 || typeof parsed?.summary !== 'string') {
		throw new Error('Invalid compaction token payload.');
	}
	return parsed;
}

export function createResponsesCompactionItem(params: {
	model?: string;
	summary: string;
	sourceItemCount: number;
	createdAt: number;
}): Record<string, any> {
	const payload: ResponsesCompactionPayload = {
		v: 1,
		model: typeof params.model === 'string' ? params.model : undefined,
		summary: typeof params.summary === 'string' ? params.summary : '',
		created_at: params.createdAt,
		source_item_count: Math.max(0, Math.floor(params.sourceItemCount || 0))
	};

	return {
		id: createCompactionId(),
		type: 'compaction',
		encrypted_content: encodeResponsesCompactionPayload(payload)
	};
}

export function expandResponsesCompactionItems(input: any[]): any[] {
	if (!Array.isArray(input)) return input;

	return input.flatMap((item) => {
		if (
			item &&
			typeof item === 'object' &&
			String(item.type || '').toLowerCase() === 'compaction' &&
			typeof item.encrypted_content === 'string'
		) {
			const payload = decodeResponsesCompactionPayload(item.encrypted_content);
			return [
				{
					type: 'message',
					role: 'developer',
					status: 'completed',
					content: [
						{
							type: 'input_text',
							text:
								'Compacted prior conversation state. Treat this as authoritative previous context for the ongoing conversation, including user facts, constraints, goals, and unresolved work.\n\n' +
								payload.summary
						}
					]
				}
			];
		}
		return [item];
	});
}
