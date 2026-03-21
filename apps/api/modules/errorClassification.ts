/**
 * Shared error classification utilities.
 *
 * Centralises the error-type detection logic that was previously duplicated
 * across providers/handler.ts and routes/openai.ts.
 */

// --- Rate-limit / Quota ---

export function isRateLimitOrQuotaError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const code = String(error?.code || error?.errorDetails?.code || '').toLowerCase();
	const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.errorDetails?.statusCode || 0);
	if (!message && !code && !status) return false;
	const memoryPressureLike =
		code === 'memory_pressure' ||
		message.includes('memory pressure') ||
		message.includes('rejected under memory pressure') ||
		message.includes('swap_used_mb=') ||
		message.includes('rss_mb=') ||
		message.includes('active_runtime_mb=') ||
		message.includes('external_mb=') ||
		message.includes('heap_used_mb=');
	if (memoryPressureLike) return false;
	return (
		message.includes('rate limit') ||
		message.includes('rate_limit') ||
		message.includes('resource_exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('payment required') ||
		message.includes('billing') ||
		message.includes('credits') ||
		message.includes('too many requests') ||
		message.includes('status 429') ||
		message.includes(' 429 ') ||
		message.includes('status 402') ||
		message.includes(' 402 ') ||
		code === 'insufficient_quota' ||
		code === 'insufficient_credits' ||
		code === 'payment_required' ||
		status === 402 ||
		message.includes('currently experiencing high demand') ||
		message.includes('spikes in demand are usually temporary') ||
		(message.includes('status": "unavailable"') ||
			message.includes("status': 'unavailable'") ||
			message.includes('"status": "unavailable"') ||
			message.includes("'status': 'unavailable'")) ||
		(status === 503 && message.includes('overload'))
	);
}

// --- Retry-After ---

/**
 * Parses a retry-after duration from an error message.
 * Returns the value in milliseconds, or null if none found.
 */
export function extractRetryAfterMs(message: string): number | null {
	if (!message) return null;
	const candidates: number[] = [];
	const collectMatches = (regex: RegExp) => {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(message)) !== null) {
			const parsed = Number.parseFloat(match[1]);
			if (Number.isFinite(parsed) && parsed > 0) {
				candidates.push(Math.ceil(parsed * 1000));
			}
		}
	};

	collectMatches(/retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/gi);
	collectMatches(/retry in ([0-9]+(?:\.[0-9]+)?)s/gi);
	collectMatches(/retry after ([0-9]+(?:\.[0-9]+)?)s/gi);

	if (candidates.length === 0) return null;
	return Math.max(...candidates);
}

/**
 * Same as extractRetryAfterMs but returns whole seconds (for HTTP Retry-After header).
 */
export function extractRetryAfterSeconds(message: string): number | null {
	const ms = extractRetryAfterMs(message);
	if (ms === null) return null;
	return Math.max(1, Math.ceil(ms / 1000));
}

// --- Rate Limit RPS ---

function toRps(value: number, unit: 'rps' | 'rpm' | 'rpd'): number {
	if (unit === 'rps') return value;
	if (unit === 'rpm') return value / 60;
	return value / 86400;
}

function parseNumber(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

function windowUnitToSeconds(unit: string): number | null {
	const normalized = unit.toLowerCase();
	if (['s', 'sec', 'secs', 'second', 'seconds'].includes(normalized))
		return 1;
	if (['m', 'min', 'mins', 'minute', 'minutes'].includes(normalized))
		return 60;
	if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(normalized)) return 3600;
	if (['d', 'day', 'days'].includes(normalized)) return 86400;
	return null;
}

/**
 * Extract an explicit rate limit (requests per second) from an error message.
 * Returns null if no explicit limit is found.
 */
export function extractRateLimitRps(message: string): number | null {
	if (!message) return null;
	const sanitized = String(message).replace(/,/g, '');

	const directPatterns: Array<{
		regex: RegExp;
		unit: 'rps' | 'rpm' | 'rpd';
	}> = [
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rps|reqs?\/s|requests?\/s|requests?\s*per\s*second)\b/i,
			unit: 'rps'
		},
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rpm|reqs?\/m|requests?\/m|requests?\s*per\s*minute)\b/i,
			unit: 'rpm'
		},
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rpd|requests?\s*per\s*day)\b/i,
			unit: 'rpd'
		}
	];

	for (const { regex, unit } of directPatterns) {
		const match = sanitized.match(regex);
		const numeric = parseNumber(match?.[1]);
		if (numeric !== null) return toRps(numeric, unit);
	}

	const windowMatch = sanitized.match(
		/(\d+(?:\.\d+)?)\s*requests?\s*(?:in|per)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i
	);
	if (windowMatch) {
		const count = parseNumber(windowMatch[1]);
		const span = parseNumber(windowMatch[2]);
		const secondsPerUnit = windowUnitToSeconds(windowMatch[3]);
		if (count !== null && span !== null && secondsPerUnit !== null) {
			const totalSeconds = span * secondsPerUnit;
			if (totalSeconds > 0) return count / totalSeconds;
		}
	}

	return null;
}

export function extractRateLimitWindow(
	message: string
): { requests: number; windowMs: number } | null {
	if (!message) return null;
	const sanitized = String(message).replace(/,/g, '');

	const directPatterns: Array<{ regex: RegExp; windowMs: number }> = [
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rps|reqs?\/s|requests?\/s|requests?\s*per\s*second)\b/i,
			windowMs: 1000
		},
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rpm|reqs?\/m|requests?\/m|requests?\s*per\s*minute)\b/i,
			windowMs: 60_000
		},
		{
			regex: /(\d+(?:\.\d+)?)\s*(?:rpd|requests?\s*per\s*day)\b/i,
			windowMs: 86_400_000
		}
	];

	for (const { regex, windowMs } of directPatterns) {
		const match = sanitized.match(regex);
		const requests = parseNumber(match?.[1]);
		if (requests !== null) {
			return { requests, windowMs };
		}
	}

	const windowMatch = sanitized.match(
		/(\d+(?:\.\d+)?)\s*requests?\s*(?:in|per)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i
	);
	if (windowMatch) {
		const requests = parseNumber(windowMatch[1]);
		const span = parseNumber(windowMatch[2]);
		const secondsPerUnit = windowUnitToSeconds(windowMatch[3]);
		if (requests !== null && span !== null && secondsPerUnit !== null) {
			const windowMs = Math.ceil(span * secondsPerUnit * 1000);
			if (windowMs > 0) {
				return { requests, windowMs };
			}
		}
	}

	return null;
}

// --- Insufficient Credits ---

export function isInsufficientCreditsError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	return (
		message.includes('requires more credits') ||
		message.includes('insufficient credits') ||
		message.includes('can only afford') ||
		message.includes('payment required') ||
		message.includes('status 402')
	);
}

// --- Invalid Credentials ---

export function isInvalidProviderCredentialError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	return (
		message.includes('api_key_invalid') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('api_key_http_referrer_blocked') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('please renew the api key') ||
		message.includes('invalid api key') ||
		message.includes('invalid authentication') ||
		message.includes('incorrect api key') ||
		message.includes('does not allow user keys') ||
		message.includes('permissioned key') ||
		message.includes('requests from referer') ||
		message.includes('http referrer blocked') ||
		message.includes('has been suspended') ||
		message.includes(
			'generative language api has not been used in project'
		) ||
		message.includes('it is disabled. enable it by visiting') ||
		message.includes('service_disabled') ||
		message.includes('unauthorized')
	);
}

// --- Model Access ---

export function isModelAccessError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	return (
		message.includes('does not have access to model') ||
		message.includes('you are not allowed to sample from this model') ||
		message.includes('not allowed to sample from this model') ||
		message.includes('not allowed to sample') ||
		message.includes('model_not_found') ||
		message.includes('no gemini model available') ||
		message.includes('no eligible image models found') ||
		message.includes('not found for api version') ||
		message.includes('model not found') ||
		(message.includes('the model') && message.includes('does not exist')) ||
		message.includes('not supported for this model') ||
		message.includes('model is not accessible') ||
		message.includes('you do not have access') ||
		(message.includes('permission denied') && message.includes('model'))
	);
}

// --- Tool Unsupported ---

export function isProviderAuthConfigurationError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	return (
		message.includes('invalid api key') ||
		message.includes('incorrect api key') ||
		message.includes('api key not found') ||
		message.includes('api_key_invalid') ||
		message.includes('invalid_api_key') ||
		message.includes('authentication') ||
		message.includes('unauthorized') ||
		message.includes('forbidden') ||
		message.includes('please pass a valid api key') ||
		message.includes('you can find your api key at https://platform.openai.com/account/api-keys')
	);
}

export function isTransientProviderGatewayError(error: any): boolean {
	const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
	const message = String(error?.message || error || '').toLowerCase();
	if (status === 502 || status === 503 || status === 504 || status === 520) return true;
	if (!message) return false;
	const hasHtmlGatewayBody =
		message.includes('<html') &&
		(
			message.includes('502 bad gateway') ||
			message.includes('503 service unavailable') ||
			message.includes('504 gateway timeout')
		);
	return (
		hasHtmlGatewayBody ||
		message.includes('bad gateway') ||
		message.includes('gateway timeout') ||
		message.includes('service unavailable') ||
		message.includes('upstream connect error') ||
		message.includes('upstream request timeout') ||
		message.includes('cloudflare') ||
		message.includes('memory pressure') ||
		message.includes('request-queue rejected under memory pressure') ||
		message.includes('empty streaming response') ||
		message.includes('returned an empty streaming response')
	);
}

export function isInvalidApiKeyError(error: any): boolean {
	const status = Number(error?.response?.status || error?.status || 0);
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	return (
		status === 401 ||
		(status === 400 && (
			message.includes('invalid api key') ||
			message.includes('incorrect api key provided') ||
			message.includes('invalid_api_key') ||
			message.includes('api key not found') ||
			message.includes('api_key_invalid') ||
			message.includes('api key expired') ||
			message.includes('api key not valid') ||
			message.includes('you can find your api key at https://platform.openai.com/account/api-keys')
		)) ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('invalid_api_key') ||
		message.includes('api key not found') ||
		message.includes('api_key_invalid') ||
		message.includes('api key expired') ||
		message.includes('api key not valid') ||
		message.includes('you can find your api key at https://platform.openai.com/account/api-keys')
	);
}

export function isMemoryPressureError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const code = String(error?.code || error?.errorDetails?.code || '').toUpperCase();
	const status = Number(error?.status || error?.statusCode || error?.errorDetails?.statusCode || 0);
	if (code === 'MEMORY_PRESSURE') return true;
	if (!message) return false;
	if (
		message.includes('memory pressure') ||
		message.includes('rejected under memory pressure') ||
		message.includes('request-queue rejected under memory pressure') ||
		message.includes('service temporarily unavailable: request-queue rejected under memory pressure') ||
		message.includes('swap_used_mb=') ||
		message.includes('rss_mb=')
	) {
		return true;
	}
	return status === 503 && (
		message.includes('service temporarily unavailable') &&
		(message.includes('request-queue') || message.includes('chat-completions:intake')) &&
		(message.includes('swap') || message.includes('rss') || message.includes('content_length='))
	);
}

export function isProviderAuthOrConfigurationError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const code = String(error?.code || error?.errorDetails?.code || '').toLowerCase();
	const status = Number(error?.status || error?.statusCode || error?.errorDetails?.statusCode || 0);
	if (!message && !code && !status) return false;
	return (
		code === 'invalid_api_key' ||
		code === 'api_key_invalid' ||
		status === 401 ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('api key not valid') ||
		message.includes('invalid_api_key') ||
		message.includes('api_key_invalid') ||
		message.includes('you can find your api key at https://platform.openai.com/account/api-keys') ||
		message.includes('unauthorized') ||
		message.includes('authentication failed')
	);
}

export function isToolUnsupportedError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
	if (!message) return false;

	if (
		status === 404 &&
		message.includes('no endpoints found') &&
		(
			message.includes('tool use') ||
			message.includes('tool_choice') ||
			message.includes('the tool') ||
			message.includes('support the provided') ||
			message.includes('supports the provided')
		)
	) {
		return true;
	}

	const patterns = [
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
		'tool choice must be auto',
		'the provided tool_choice value',
		'tools are not supported',
		'tools is not supported',
		'tools not supported',
		'does not support tools',
		'does not support tool',
		'function calling is not supported',
		'function_call is not supported',
		'no endpoints found that support tool use',
		'no endpoints found that support the tool',
		"no endpoints found that support the provided 'tool_choice' value",
		'no endpoints found that support the provided tool_choice value',
		'client side tool is not supported for multi-agent models',
		'client-side tools for multi-agent models require beta access',
		'requires beta access',
		'requires that either input content or output modality contain audio',
		'this model requires that either input content or output modality contain audio',
		'requires audio input',
		'requires audio output',
		'audio-only',
		'audio only'
	];

	if (patterns.some(pattern => message.includes(pattern))) return true;
	if (message.includes('tools') && message.includes('not supported'))
		return true;
	if (message.includes('tool use') && message.includes('no endpoints found'))
		return true;
	if (message.includes('output modality') && message.includes('audio'))
		return true;
	return false;
}
