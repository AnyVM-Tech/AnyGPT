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
	const providerContext = [
		error?.providerId,
		error?.provider,
		error?.providerName,
		error?.errorDetails?.providerId,
		error?.errorDetails?.provider,
		error?.errorDetails?.providerName,
		error?.modelId,
		error?.errorDetails?.modelId,
	].map((value) => String(value || '').toLowerCase()).join(' ');
	if (!message && !code && !status && !providerContext) return false;
	const memoryPressureLike =
		code === 'memory_pressure' ||
		message.includes('memory pressure') ||
		message.includes('rejected under memory pressure') ||
		message.includes('swap_used_mb=') ||
		message.includes('rss_mb=') ||
		message.includes('active_runtime_mb=') ||
		message.includes('external_mb=') ||
		message.includes('heap_used_mb=');
	const providerRetryChurnLike =
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('timeout: switching provider') ||
		message.includes('switching provider') ||
		message.includes('no access: switching provider') ||
		message.includes('unauthorized: switching provider') ||
		message.includes('quota exceeded: switching provider');
	const providerCredentialDriftLike =
		(
			(message.includes('openrouter') || providerContext.includes('openrouter')) && (
				message.includes('unauthorized') ||
				message.includes('key_invalid') ||
				message.includes('invalid api key') ||
				message.includes('invalid_api_key') ||
				message.includes('incorrect api key') ||
				message.includes('quota exceeded') ||
				message.includes('key_no_quota') ||
				status === 401 ||
				status === 402
			)
		) ||
		(
			(message.includes('openai') || providerContext.includes('openai')) && (
				message.includes('unauthorized') ||
				message.includes('key_invalid') ||
				message.includes('invalid api key') ||
				message.includes('invalid_api_key') ||
				message.includes('incorrect api key') ||
				message.includes('quota exceeded') ||
				message.includes('key_no_quota') ||
				status === 401 ||
				status === 402
			)
		);		status === 401 ||
		status === 402;
	const upstreamAuthOrGovernanceDriftLike =
		providerCredentialDriftLike ||
		message.includes('unauthorized') ||
		message.includes('key_invalid') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('api key not valid') ||
		message.includes('api has not been used in project') ||
		message.includes('service disabled') ||
		message.includes('generative language api has not been used') ||
		message.includes('enable it by visiting') ||
		message.includes('project is not permitted') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		message.includes('access denied') ||
		message.includes('expired api key') ||
		message.includes('api key expired') ||
		message.includes('quota exceeded') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient_quota') ||
		message.includes('billing hard limit') ||
		message.includes('credit balance is too low') ||
		((message.includes('openrouter') || message.includes('openai')) && (
			status === 401 ||
			status === 402 ||
			message.includes('status 401') ||
			message.includes('status 402') ||
			message.includes('invalid api key') ||
			message.includes('invalid_api_key') ||
			message.includes('key_invalid') ||
			message.includes('unauthorized') ||
			message.includes('quota exceeded') ||
			message.includes('key_no_quota')
		)) ||
		message.includes('quota exceeded') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient_quota') ||
		message.includes('credit balance is too low') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('project has exceeded quota') ||
		((message.includes('openrouter') || message.includes('openai')) &&
			(message.includes('quota') ||
			message.includes('unauthorized') ||
			message.includes('invalid_api_key') ||
			message.includes('invalid api key') ||
			message.includes('key_invalid'))) ||
		message.includes('disabled api key') ||
		message.includes('invalid credentials') ||
		message.includes('invalid token') ||
		message.includes('invalid access token') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('authorization error') ||
		message.includes('account suspended') ||
		code === 'key_invalid' ||
		code === 'econnrefused' ||
		status === 401 ||
		message.includes('status 401') ||
		status === 403 ||
		message.includes('status 403') ||
		message.includes('econnrefused');
	const geminiCapabilityMismatchLike =
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('generatecontent unsupported') ||
		message.includes('model does not support generatecontent') ||
		message.includes('unsupported input mime type') ||
		(status === 400 && code === 'invalid_argument' && (
			message.includes('function calling') ||
			message.includes('mime type') ||
			message.includes('generatecontent')
		));
	const upstreamQuotaGovernanceDriftLike =
		message.includes('key_no_quota') ||
		code === 'key_no_quota' ||
		status === 402 ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota remaining') ||
		message.includes('quota limit reached') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this month') ||
		message.includes('resource has been exhausted') ||
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('unsupported (rate limit/timeout)') ||
		message.includes('provider switch worthless') ||
		message.includes('request retry worthless') ||
		message.includes('retry worthless') ||
		message.includes('rate limit') ||
		message.includes('rate limited') ||
		message.includes('too many requests') ||
		message.includes('exceeded your current quota') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment method') ||
		message.includes('payment failed') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('payment is required') ||
		message.includes('quota payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('credits are required') ||
		message.includes('credit balance required') ||
		message.includes('credit balance is insufficient') ||
		message.includes('insufficient funds') ||
		message.includes('out of credits') ||
		message.includes('no credits remaining') ||
		message.includes('billing not active') ||
		message.includes('billing issue') ||
		message.includes('subscription required') ||
		message.includes('account not funded') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account_not_active') ||
		message.includes('account not active') ||
		message.includes('payment required or credits exhausted') ||
		message.includes('credits exhausted for this request') ||
		message.includes('provider has insufficient credits') ||
		message.includes('provider credits exhausted') ||
		message.includes('quota or payment') ||
		message.includes('402 payment') ||
		message.includes('status code 402') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('out of credits') ||
		message.includes('credits remaining') ||
		message.includes('no credits remaining') ||
		message.includes('billing quota exceeded') ||
		message.includes('payment required by provider') ||
		message.includes('provider credits exhausted') ||
		message.includes('insufficient quota') ||
		message.includes('quota unavailable') ||
		message.includes('out of credits') ||
		message.includes('out of balance') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing hard limit reached') ||
		message.includes('recharge your balance') ||
		message.includes('add payment details') ||
		message.includes('payment source') ||
		message.includes('402 payment required') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('account has insufficient credits') ||
		message.includes('no credits left') ||
		message.includes('out of credits') ||
		message.includes('payment source required') ||
		message.includes('subscription required') ||
		message.includes('insufficient credits to process request') ||
		message.includes('insufficient credits to process this request') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('account balance too low') ||
		message.includes('balance too low') ||
		message.includes('payment required due to insufficient credits') ||
		message.includes('billing required') ||
		message.includes('billing issue') ||
		message.includes('billing error') ||
		message.includes('billing unavailable') ||
		message.includes('billing not active') ||
		message.includes('billing account') ||
		message.includes('insufficient funds') ||
		message.includes('low balance') ||
		message.includes('balance too low') ||
		message.includes('account balance') ||
		message.includes('credits left') ||
		message.includes('out of credits') ||
		message.includes('no credits') ||
		message.includes('402 payment') ||
		message.includes('status code 402') ||
		message.includes('status code: 402') ||
		message.includes('insufficient_quota') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing hard limit reached') ||
		message.includes('monthly spend limit reached') ||
		message.includes('usage limit reached') ||
		message.includes('account balance') ||
		message.includes('add credits') ||
		message.includes('recharge your balance') ||
		message.includes('no credits left') ||
		message.includes('out of credits') ||
		message.includes('not enough credits') ||
		message.includes('low balance') ||
		message.includes('balance too low') ||
		message.includes('billing not active') ||
		message.includes('billing inactive') ||
		message.includes('billing issue') ||
		message.includes('subscription required') ||
		message.includes('account not active') ||
		message.includes('insufficient credits remaining') ||
		message.includes('insufficient balance remaining') ||
		message.includes('no credits left') ||
		message.includes('out of credits') ||
		message.includes('billing not active') ||
		message.includes('billing inactive') ||
		message.includes('account balance is too low') ||
		message.includes('payment required due to quota') ||
		message.includes('402 payment required') ||
		message.includes('insufficient credits to process request') ||
		message.includes('insufficient credits remaining') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('billing not active') ||
		message.includes('billing inactive') ||
		message.includes('account not funded') ||
		message.includes('payment source required') ||
		message.includes('payment source is required') ||
		message.includes('recharge required') ||
		message.includes('top up required') ||
		message.includes('top-up required') ||
		message.includes('insufficient credits to process request') ||
		message.includes('insufficient credits remaining') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('account balance is too low') ||
		message.includes('billing not active') ||
		message.includes('billing inactive') ||
		message.includes('billing required') ||
		message.includes('recharge required') ||
		message.includes('top up your balance') ||
		message.includes('add credits') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('account_not_active') ||
		message.includes('no credits') ||
		message.includes('out of credits') ||
		message.includes('credits remaining') ||
		message.includes('add credits') ||
		message.includes('recharge required') ||
		message.includes('top up your balance') ||
		message.includes('top-up your balance') ||
		message.includes('purchase credits') ||
		message.includes('payment status') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account_not_active') ||
		message.includes('account not active') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('provider has no available credits') ||
		message.includes('provider has insufficient credits') ||
		message.includes('provider credits exhausted') ||
		message.includes('provider quota exhausted') ||
		message.includes('provider quota exceeded') ||
		message.includes('insufficient funds') ||
		message.includes('insufficient credits remaining') ||
		message.includes('out of credits') ||
		message.includes('no credits remaining') ||
		message.includes('billing not active') ||
		message.includes('billing issue') ||
		message.includes('billing error') ||
		message.includes('payment source') ||
		message.includes('recharge required') ||
		message.includes('top up required') ||
		message.includes('add credits') ||
		message.includes('purchase credits') ||
		message.includes('account balance too low') ||
		message.includes('insufficient credits to process request') ||
		message.includes('insufficient credits remaining') ||
		message.includes('no credits remaining') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing limit reached') ||
		message.includes('payment required by provider') ||
		message.includes('provider credits exhausted') ||
		message.includes('billing required') ||
		message.includes('billing issue') ||
		message.includes('billing error') ||
		message.includes('billing unavailable') ||
		message.includes('billing not active') ||
		message.includes('account balance') ||
		message.includes('low balance') ||
		message.includes('balance too low') ||
		message.includes('insufficient funds') ||
		message.includes('out of credits') ||
		message.includes('out of quota') ||
		message.includes('quota payment') ||
		message.includes('402 payment') ||
		message.includes('status code 402') ||
		message.includes('credit balance is required') ||
		message.includes('credit balance too low') ||
		message.includes('balance too low') ||
		message.includes('insufficient quota') ||
		message.includes('insufficient funds') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('no credits remaining') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('insufficient_quota') ||
		message.includes('credit limit reached') ||
		message.includes('billing not active') ||
		message.includes('billing account') ||
		message.includes('account balance') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account balance') ||
		message.includes('low balance') ||
		message.includes('out of credits') ||
		message.includes('credits remaining') ||
		message.includes('402 payment') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota limit reached') ||
		message.includes('quota has been exceeded') ||
		message.includes('resource has been exhausted') ||
		status === 402 ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('no active subscription') ||
		message.includes('subscription required') ||
		message.includes('credits exhausted for provider') ||
		message.includes('provider credits exhausted') ||
		message.includes('provider quota exhausted') ||
		message.includes('provider balance exhausted') ||
		message.includes('balance too low') ||
		message.includes('not enough credits') ||
		message.includes('not enough balance') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('account balance') ||
		message.includes('balance is too low') ||
		message.includes('billing quota') ||
		message.includes('payment or billing issue') ||
		message.includes('402 payment required') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('account has insufficient credits') ||
		message.includes('payment required due to insufficient credits') ||
		message.includes('quota or payment') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('insufficient_quota') ||
		message.includes('billing_not_active') ||
		message.includes('account_not_active') ||
		message.includes('credits have been exhausted') ||
		message.includes('credit balance depleted') ||
		message.includes('payment required by provider') ||
		message.includes('provider has no quota remaining') ||
		message.includes('out of credits') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('billing quota exceeded') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('no quota remaining') ||
		message.includes('out of credits') ||
		message.includes('billing not active') ||
		message.includes('billing inactive') ||
		message.includes('payment source required') ||
		message.includes('insufficient credits remaining') ||
		message.includes('credits remaining') ||
		message.includes('payment credits') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing limit reached') ||
		message.includes('monthly spend limit reached') ||
		message.includes('usage limit reached') ||
		message.includes('account balance') ||
		message.includes('low balance') ||
		message.includes('balance too low') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('provider routing/probing blocked') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('payment for this request') ||
		message.includes('payment is required to process this request') ||
		message.includes('credits are required') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('402 payment') ||
		message.includes('status 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('402 payment required') ||
		message.includes('402 quota') ||
		message.includes('payment/quota') ||
		message.includes('credits remaining') ||
		message.includes('request failed with status code 402') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('no allowed providers are available');
		message.includes('request failed with status code 402') ||
		message.includes('402 payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required for this operation') ||
		message.includes('payment required for this model') ||
		message.includes('credits are required') ||
		message.includes('not enough credits') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('balance exhausted') ||
		message.includes('billing quota exceeded') ||
		message.includes('quota or payment') ||
		message.includes('402') && (
			message.includes('openrouter') ||
			message.includes('payment') ||
			message.includes('quota') ||
			message.includes('credit') ||
			message.includes('billing')
		) ||
		message.includes('status code 402') ||
		message.includes('http 402') ||
		message.includes('402 payment required') ||
		message.includes('request failed with status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('402 payment required') ||
		message.includes('payment/quota') ||
		message.includes('quota/payment') ||
		message.includes('no allowed providers are available for the selected model') ||
		status === 402 ||
		message.includes('status code 402') ||
		message.includes('status 402') ||
		message.includes('http 402') ||
		message.includes('402 payment required') ||
		message.includes('request failed with status code 402') ||
		(code === 'err_bad_request' && status === 402) ||
		status === 402 ||
		message.includes('out of balance') ||
		message.includes('billing hard limit') ||
		message.includes('billing soft limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('billing not active') ||
		message.includes('credits remaining') ||
		message.includes('out of credits') ||
		message.includes('no credits') ||
		message.includes('no allowed providers are available') ||
		message.includes('402 payment required') ||
		message.includes('status 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('402') && (
			message.includes('credit') ||
			message.includes('credits') ||
			message.includes('quota') ||
			message.includes('payment') ||
			message.includes('billing')
		) ||
		status === 402 ||
		status === 429 ||
		message.includes('status 429') ||
		code === 'payment_required';
		message.includes('request failed with status code 429') ||
		message.includes('quota exceeded for this provider') ||
		message.includes('provider quota exceeded') ||
		message.includes('quota exceeded for this organization') ||
		message.includes('no allowed providers are available for the selected model') ||
		(status === 404 && message.includes('allowed providers')) ||
		(status === 404 && message.includes('selected model')) ||
		(status === 402 && message.includes('openrouter')) ||
		(status === 402 && message.includes('payment')) ||
		(status === 402 && message.includes('quota'));
		geminiCapabilityMismatchLike ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('does not support sendmessage') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('generatecontent unsupported') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('generatecontent unsupported') ||
		message.includes('credit balance is too low') ||
		message.includes('account not active') ||
		message.includes('project has exceeded quota') ||
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('unsupported input mime type') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('model does not support generatecontent');
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('requires more credits') ||
		message.includes('can only afford') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('organization must be verified') ||
		message.includes('account deactivated') ||
		message.includes('provider account is disabled') ||
		message.includes('api key disabled') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support \'generatecontent\'') ||
		message.includes('does not support "generatecontent"') ||
		message.includes('image generation unavailable in country') ||
		message.includes('image generation unavailable in provider region') ||
		message.includes('provider_cap_blocked') ||
		message.includes('provider_model_removed') ||
		message.includes('image generation unavailable in country') ||
		message.includes('image generation unavailable in provider region') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('switching provider due to rate limit') ||
		message.includes('switching provider due to timeout') ||
		message.includes('probe_retry') ||
		message.includes('provider switch worthless') ||
		message.includes('request retry worthless') ||
		message.includes('no allowed providers are available for the selected model') ||
		(status === 404 && message.includes('allowed providers')) ||
		message.includes('rate limit/timeout: switching provider') ||
		(message.includes('switching provider') && (message.includes('rate limit') || message.includes('timeout'))) ||
		message.includes('image generation unavailable in country') ||
		message.includes('image generation unavailable in provider region') ||
		message.includes('generation is unavailable in your country') ||
		message.includes('generation is unavailable in your region') ||
		message.includes('cannot fetch content from the provided url') ||
		message.includes('resource has been exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota reached') ||
		message.includes('quota limit reached') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('credit balance is too low') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('payment required') ||
		message.includes('payment required to access this model') ||
		message.includes('key_no_quota') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('provider account is disabled') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('status 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('credit balance is too low') ||
		message.includes('requires more credits') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('billing hard limit') ||
		message.includes('billing soft limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('account deactivated') ||
		message.includes('organization must be verified') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('api key disabled') ||
		(status === 401 && !message.includes('not found')) ||
		status === 402 ||
		status === 402 ||
		status === 403 ||
		(code === 'err_bad_response' && status >= 500) ||
		(code === 'err_bad_request' && status === 402) ||
		status >= 500 ||
		message.includes('request failed with status code 500') ||
		message.includes('request failed with status code 502') ||
		message.includes('request failed with status code 503') ||
		message.includes('request failed with status code 504') ||
		message.includes('internal server error') ||
		message.includes('bad gateway') ||
		message.includes('service unavailable') ||
		message.includes('gateway timeout') ||
		message.includes('upstream request failed') ||
		message.includes('upstream service unavailable') ||
		message.includes('upstream request failed') ||
		message.includes('upstream error') ||
		message.includes('upstream service error') ||
		message.includes('upstream server error') ||
		message.includes('provider server error') ||
		message.includes('provider returned 5') ||
		message.includes('provider returned 50') ||
		message.includes('provider returned 51') ||
		message.includes('provider returned 52') ||
		message.includes('provider returned 53') ||
		message.includes('provider returned 54') ||
		message.includes('axioserror') ||
		(code === 'err_bad_response' && status >= 500) ||
		message.includes('err_bad_response') ||
		message.includes('request failed with status code 500') ||
		message.includes('request failed with status code 502') ||
		message.includes('request failed with status code 503') ||
		message.includes('request failed with status code 504') ||
		message.includes('request failed with status code 5') ||
		message.includes('upstream request failed with status code 5') ||
		message.includes('returned an empty streaming response') ||
		message.includes('empty streaming response') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api_key_invalid') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('invalid authentication') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('access token expired') ||
		message.includes('expired access token') ||
		message.includes('invalid access token') ||
		message.includes('invalid token') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('resource has been exhausted') ||
		message.includes('api_key_invalid') ||
		message.includes('not_authorized_invalid_key_type') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('request failed with status code 401') ||
		status === 429 ||
		message.includes('status 429') ||
		message.includes('request failed with status code 429') ||
		message.includes('resource has been exhausted') ||
		message.includes('rate limit exceeded') ||
		message.includes('too many requests') ||
		(status >= 500 && status < 600) ||
		message.includes('status 500') ||
		message.includes('status 502') ||
		message.includes('status 503') ||
		message.includes('status 504') ||
		message.includes('request failed with status code 500') ||
		message.includes('request failed with status code 502') ||
		message.includes('request failed with status code 503') ||
		message.includes('request failed with status code 504') ||
		message.includes('api key revoked') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('invalid authentication') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('unauthorized') ||
		message.includes('status 401') ||
		message.includes('request failed with status code 401') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'authentication_error' ||
		message.includes('provider account disabled') ||
		message.includes('unauthorized') ||
		message.includes('request failed with status code 401') ||
		message.includes('request failed with status code 403') ||
		message.includes('unauthorized') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('key_invalid') ||
		message.includes('key invalid') ||
		message.includes('invalid authentication') ||
		message.includes('incorrect api key') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('invalid authentication') ||
		message.includes('incorrect api key') ||
		message.includes('api key not valid') ||
		message.includes('api_key_invalid') ||
		message.includes('401 unauthorized') ||
		message.includes('status 401') ||
		status === 401 ||
		code === 'unauthorized';
		message.includes('requires more credits to run this request') ||
		message.includes('provider billing') ||
		message.includes('provider quota') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('invalid authentication') ||
		message.includes('incorrect api key') ||
		message.includes('api key not valid') ||
		message.includes('api key not found') ||
		message.includes('api key expired') ||
		message.includes('please renew the api key') ||
		message.includes('provider account disabled') ||
		message.includes('provider account is disabled') ||
		status === 401 ||
		message.includes('status 401');
		message.includes('provider billing disabled') ||
		message.includes('provider billing not active') ||
		message.includes('provider has no credits') ||
		message.includes('provider has insufficient credits') ||
		message.includes('provider quota') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		(message.includes('request failed with status code 401') &&
			(message.includes('openrouter') || message.includes('openai'))) ||
		(message.includes('request failed with status code 402') &&
			(message.includes('openrouter') || message.includes('openai'))) ||
		message.includes('not authorized') ||
		message.includes('not authorised') ||
		message.includes('authorization failed') ||
		message.includes('authorisation failed') ||
		message.includes('authentication failed') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('invalid token') ||
		message.includes('invalid access token') ||
		message.includes('incorrect api key') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('api_key_invalid') ||
		status === 401 ||
		message.includes('status 401') ||
		code === 'key_invalid' ||
		code === 'invalid_api_key';
		message.includes('status 401') ||
		status === 401 ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		status === 402 ||
		message.includes('status 402') ||
		code === 'key_invalid' ||
		code === 'key_no_quota' ||
		message.includes('please renew the api key') ||
		message.includes('incorrect api key') ||
		message.includes('authentication failed') ||
		message.includes('authentication error') ||
		message.includes('authentication_error') ||
		message.includes('invalid credentials') ||
		message.includes('invalid authorization') ||
		message.includes('unauthorized') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid authentication') ||
		status === 401 ||
		status === 402;
		message.includes('incorrect api key') ||
		message.includes('authentication failed') ||
		message.includes('authentication error') ||
		message.includes('authentication_error') ||
		message.includes('key_invalid') ||
		status === 401 ||
		message.includes('status 401') ||
		status === 402 ||
		message.includes('status 402');
	const upstreamProviderAvailabilityDriftLike =
		message.includes('no allowed providers are available for the selected model') ||
		message.includes('no allowed providers are available for this model') ||
		message.includes('no allowed providers are available for the requested model') ||
		message.includes('no allowed providers available for the selected model') ||
		message.includes('no allowed providers available for this model') ||
		message.includes('openrouter api call failed: no allowed providers are available') ||
		(message.includes('no allowed providers are available') && status === 404) ||
		(message.includes('selected model') && message.includes('status 404')) ||
		(message.includes('allowed providers') && message.includes('selected model')) ||
		(message.includes('allowed providers') && message.includes('requested model')) ||
		(message.includes('allowed providers') && message.includes('status 404')) ||
		(message.includes('openrouter') && message.includes('allowed providers') && status === 404);
	const upstreamRateLimitOrTimeoutSwitchChurnLike =
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('unsupported (rate limit/timeout)') ||
		message.includes('provider retry worthless') ||
		message.includes('request retry worthless') ||
		message.includes('provider switch worthless') ||
		message.includes('switching provider due to rate limit') ||
		message.includes('switching provider due to timeout') ||
		message.includes('timed out switching provider') ||
		message.includes('switching provider') ||
		message.includes('switch provider') ||
		message.includes('retrying with another provider') ||
		message.includes('retrying another provider') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('check quota') ||
		(message.includes('timeout') && message.includes('switching provider')) ||
		(message.includes('rate limit') && message.includes('switching provider')) ||
		(message.includes('timed out') && message.includes('provider'));
	if (memoryPressureLike || providerRetryChurnLike || upstreamAuthOrGovernanceDriftLike || upstreamQuotaGovernanceDriftLike || upstreamProviderAvailabilityDriftLike || upstreamRateLimitOrTimeoutSwitchChurnLike) return false;
	return (
		message.includes('rate limit') ||
		message.includes('rate_limit') ||
		message.includes('resource_exhausted') ||
		message.includes('payment required') ||
		message.includes('billing') ||
		message.includes('credits') ||
		message.includes('too many requests') ||
		message.includes('status 429') ||
		message.includes(' 429 ') ||
		message.includes('status 402') ||
		message.includes(' 402 ') ||
		message.includes('no endpoints found that support') ||
		message.includes('provider routing') ||
		message.includes('tool_choice value') ||
		message.includes('tool choice must be auto') ||
		message.includes('requires beta access') ||
		message.includes('provider payment required') ||
		message.includes('payment required') ||
		message.includes('payment method required') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('credit balance is too low') ||
		message.includes('requires more credits') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('can only afford') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('provider account is disabled') ||
		message.includes('organization must be verified') ||
		message.includes('account deactivated') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('unsupported input mime type') ||
		message.includes('cannot fetch content from the provided url') ||
		message.includes('failed to fetch content from the provided url') ||
		message.includes('could not fetch content from the provided url') ||
		message.includes('unable to fetch content from the provided url') ||
		message.includes('cannot fetch image from the provided url') ||
		message.includes('failed to fetch image from the provided url') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes("does not support 'generatecontent'") ||
		message.includes('resource has been exhausted') ||
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
		message.includes('insufficient credit') ||
		message.includes('can only afford') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('credit balance is too low') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('status 402')
	);
}

// --- Invalid Credentials ---

export function isInvalidProviderCredentialError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const status = Number((error as any)?.status || (error as any)?.statusCode || (error as any)?.response?.status || 0);
	const code = String((error as any)?.code || (error as any)?.error?.code || '').toLowerCase();
	const errorType = String((error as any)?.type || (error as any)?.error?.type || '').toLowerCase();
	if (!message && status === 0 && !code && !errorType) return false;
	return (
		message.includes('api_key_invalid') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('please renew the api key') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('invalid credential') ||
		message.includes('invalid credentials') ||
		message.includes('invalid token') ||
		message.includes('invalid access token') ||
		message.includes('access token is invalid') ||
		message.includes('access token has expired') ||
		message.includes('access token expired') ||
		message.includes('expired api key') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authentication') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('api key disabled') ||
		message.includes('account deactivated') ||
		message.includes('provider account is disabled') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authentication credentials') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		errorType === 'authentication_error' ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		(status === 401 && (
			code.includes('invalid_api_key') ||
			code.includes('key_invalid') ||
			code.includes('unauthorized') ||
			errorType.includes('authentication_error')
		)) ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		errorType === 'authentication_error' ||
		status === 401 ||
		status === 403 ||
		status === 407 ||
		status === 511 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authentication') ||
		message.includes('invalid_auth') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('401 unauthorized') ||
		status === 401 ||
		errorType === 'authentication_error' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		code === 'unauthorized' ||
		code === 'authentication_error' ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authorization header') ||
		message.includes('missing api key') ||
		message.includes('missing access token') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		errorType === 'authentication_error' ||
		message.includes('expired token') ||
		message.includes('missing api key') ||
		message.includes('api key is missing') ||
		message.includes('malformed api key') ||
		message.includes('invalid authentication') ||
		message.includes('invalid authentication credentials') ||
		message.includes('authentication credentials are invalid') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		status === 401 ||
		status === 403 ||
		message.includes('invalid authentication credentials') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		status === 401 ||
		code === 'unauthorized' ||
		errorType === 'authentication_error' ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		errorType === 'key_invalid' ||
		errorType === 'invalid_api_key' ||
		(status === 401 && (
			code === 'invalid_api_key' ||
			code === 'key_invalid' ||
			code === 'unauthorized' ||
			message.includes('api key') ||
			message.includes('access token') ||
			message.includes('authentication')
		)) ||
		message.includes('auth failed') ||
		message.includes('invalid authentication') ||
		message.includes('authentication_error') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		message.includes('access denied') ||
		message.includes('api key disabled') ||
		message.includes('provider account is disabled') ||
		message.includes('account deactivated') ||
		message.includes('project is not authorized') ||
		message.includes('project has been disabled') ||
		message.includes('api has not been used in project') ||
		message.includes('service disabled') ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		code === 'authentication_error' ||
		status === 401 ||
		status === 403 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		status === 401 ||
		status === 403 ||
		status === 402 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api_key_invalid') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('key_no_quota') ||
		status === 401 ||
		status === 402 ||
		status === 403 ||
		message.includes('invalid api key provided') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('api key is invalid') ||
		message.includes('api key is missing') ||
		message.includes('missing api key') ||
		message.includes('invalid authorization header') ||
		message.includes('authorization header is malformed') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('access token expired') ||
		message.includes('token expired') ||
		message.includes('invalid jwt') ||
		message.includes('jwt expired') ||
		message.includes('permission denied') ||
		message.includes('forbidden') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		status === 401 ||
		status === 402 ||
		message.includes('unauthorized access') ||
		message.includes('invalid authorization') ||
		message.includes('invalid bearer token') ||
		message.includes('invalid access token') ||
		message.includes('access token expired') ||
		message.includes('token expired') ||
		message.includes('invalid token') ||
		message.includes('invalid jwt') ||
		message.includes('jwt expired') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		message.includes('access denied') ||
		message.includes('missing api key') ||
		message.includes('missing api-key') ||
		message.includes('missing access token') ||
		message.includes('no api key provided') ||
		message.includes('no auth credentials found') ||
		message.includes('invalid x-api-key') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api key not valid') ||
		message.includes('api key not found') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('payment required') ||
		message.includes('resource has been exhausted') ||
		status === 401 ||
		status === 402 ||
		status === 403 ||
		message.includes('invalid authorization') ||
		message.includes('invalid bearer') ||
		message.includes('invalid access token') ||
		message.includes('missing api key') ||
		message.includes('missing api-key') ||
		message.includes('missing authorization') ||
		message.includes('authorization header') ||
		message.includes('bearer token') ||
		message.includes('access token') ||
		status === 401 ||
		message.includes('authentication error') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('invalid access token') ||
		message.includes('access token expired') ||
		message.includes('invalid token') ||
		message.includes('token expired') ||
		message.includes('401 unauthorized') ||
		message.includes('status code 401') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'authentication_error' ||
		message.includes('api_key_invalid') ||
		message.includes('not_authorized_invalid_key_type') ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('payment required') ||
		message.includes('payment required to access this model') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		status === 402 ||
		status === 402 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api key not valid') ||
		message.includes('api key not found') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('expired token') ||
		message.includes('not_authorized_invalid_key_type') ||
		status === 401 ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('access token is invalid') ||
		message.includes('invalid access token') ||
		message.includes('invalid oauth token') ||
		message.includes('token is invalid') ||
		message.includes('token has expired') ||
		message.includes('provider_disabled') ||
		message.includes('provider disabled') ||
		message.includes('account deactivated') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('bearer token has expired') ||
		message.includes('access token is invalid') ||
		message.includes('access token expired') ||
		message.includes('invalid access token') ||
		message.includes('invalid oauth token') ||
		message.includes('401 unauthorized') ||
		message.includes('status code 401') ||
		status === 401 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		message.includes('access denied') ||
		status === 401 ||
		status === 403 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('incorrect api key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('api key disabled') ||
		message.includes('api key revoked') ||
		message.includes('api key expired') ||
		message.includes('expired api key') ||
		message.includes('invalid token') ||
		message.includes('expired token') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('credit balance is too low') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		status === 401 ||
		status === 402 ||
		status === 403 ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token') ||
		message.includes('invalid authorization header') ||
		message.includes('authorization header') ||
		message.includes('invalid access token') ||
		message.includes('access token expired') ||
		message.includes('token expired') ||
		message.includes('401 unauthorized') ||
		status === 401 ||
		code === 'unauthorized' ||
		message.includes('authorization failed') ||
		message.includes('invalid authorization') ||
		message.includes('invalid auth') ||
		message.includes('bad api key') ||
		message.includes('invalid access token') ||
		message.includes('access token expired') ||
		message.includes('token expired') ||
		status === 401 ||
		(code === 'err_bad_request' && status === 401) ||
		(code === 'err_bad_response' && status === 401) ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('permission denied') ||
		message.includes('access denied') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key_invalid') ||
		message.includes('key invalid') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		status === 401 ||
		status === 403 ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('forbidden') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key_invalid') ||
		message.includes('key invalid') ||
		message.includes('api key not valid') ||
		message.includes('api key not found') ||
		message.includes('incorrect api key') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		status === 401 ||
		status === 403 ||
		message.includes('unauthorized access') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('invalid access token') ||
		message.includes('access token expired') ||
		message.includes('token expired') ||
		message.includes('invalid signature') ||
		message.includes('permission denied') ||
		message.includes('forbidden') ||
		message.includes('status code 401') ||
		message.includes('status code 403') ||
		message.includes('status 401') ||
		message.includes('status 403') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('credit balance is too low') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		status === 401 ||
		status === 403 ||
		message.includes('unauthorized') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('key_invalid') ||
		message.includes('api key not valid') ||
		message.includes('api_key_invalid') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('unauthorized access') ||
		message.includes('access token expired') ||
		message.includes('invalid access token') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('insufficient_quota') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('resource has been exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		(status === 401 && (message.includes('unauthorized') || code === 'err_bad_request')) ||
		status === 402 ||
		status === 403 ||
		(code === 'err_bad_response' && status >= 500) ||
		message.includes('authentication error') ||
		message.includes('api key disabled') ||
		message.includes('provider account is disabled') ||
		message.includes('account deactivated') ||
		message.includes('invalid api key provided') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('unauthorized') ||
		message.includes('forbidden') ||
		(status === 401 && !message.includes('rate limit')) ||
		(status === 403 && (
			message.includes('api key') ||
			message.includes('auth') ||
			message.includes('token') ||
			message.includes('credential') ||
			message.includes('forbidden')
		)) ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('invalid authentication') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('api_key_invalid') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		status === 401 ||
		status === 403 ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		code === 'unauthorized' ||
		message.includes('incorrect api key') ||
		message.includes('api_key_invalid') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('401') ||
		status === 401 ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		status === 402 ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('credits are required') ||
		message.includes('credits required') ||
		message.includes('can only afford') ||
		message.includes('provider_disabled') ||
		message.includes('access terminated') ||
		status === 401 ||
		status === 402 ||
		message.includes('status 401') ||
		message.includes('status 402') ||
		message.includes('request failed with status code 401') ||
		message.includes('request failed with status code 402') ||
		message.includes('request failed with status code 402') ||		message.includes('expired access token') ||
		message.includes('invalid authentication') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('unauthorized') ||
		message.includes('unauthorized:') ||
		message.includes('unauthorized request') ||
		message.includes('invalid credentials') ||
		message.includes('key_invalid') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('payment required') ||
		message.includes('insufficient credits') ||
		message.includes('credits required') ||
		message.includes('request failed with status code 401') ||
		message.includes('request failed with status code 402') ||
		status === 401 ||
		status === 402 ||
		message.includes('authentication_error') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('key no quota') ||
		message.includes('key_no_quota') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('request failed with status code 401') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('invalid api key provided') ||
		message.includes('invalid or missing api key') ||
		message.includes('invalid credentials') ||
		message.includes('invalid_api_key') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		status === 401 ||
		status === 402 ||
		message.includes('quota exceeded for this provider') ||
		message.includes('provider quota exceeded') ||
		message.includes('quota exceeded for this organization') ||
		message.includes('exceeded your current quota') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('credit balance is too low') ||
		message.includes('payment method required') ||
		message.includes('account not active') ||
		message.includes('organization must be verified') ||
		message.includes('provider account is disabled') ||
		status === 402 ||
		message.includes('request failed with status code 402') ||
		message.includes('payment method required') ||
		message.includes('account not active') ||
		message.includes('account deactivated') ||
		message.includes('provider account is disabled') ||
		message.includes('api key disabled') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('status 402') ||
		message.includes('request failed with status code 402') ||
		status === 402 ||
		message.includes('invalid bearer [redacted]') ||
		message.includes('bearer [redacted] is invalid') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('credit balance is too low') ||
		message.includes('account not active') ||
		message.includes('provider account is disabled') ||
		message.includes('organization must be verified') ||
		status === 402 ||
		message.includes('status 402') ||
		message.includes('bearer [redacted] has expired') ||
		message.includes('invalid authorization header') ||
		message.includes('authorization header is malformed') ||
		message.includes('missing api key') ||		message.includes('invalid credentials') ||
		message.includes('invalid access token') ||
		message.includes('invalid token') ||
		message.includes('incorrect api key') ||
		message.includes('invalid key') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('unauthorized request') ||
		message.includes('request failed with status code 401') ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		message.includes('missing authentication') ||
		message.includes('no api key provided') ||
		message.includes('incorrect api key') ||
		message.includes('does not allow user keys') ||
		message.includes('permissioned key') ||
		message.includes('requests from referer') ||
		message.includes('http referrer blocked') ||
		message.includes('has been suspended') ||
		message.includes('key invalid') ||
		message.includes('key_invalid') ||
		message.includes('invalid token') ||
		message.includes('access token is invalid') ||
		message.includes('invalid access token') ||
		message.includes('invalid bearer token') ||
		message.includes('bearer token is invalid') ||
		message.includes('bad api key') ||
		message.includes('malformed api key') ||
		message.includes('malformed authentication') ||
		message.includes('request failed with status code 401') ||
		message.includes('status 401') ||
		status === 401 ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		message.includes('invalid key') ||
		message.includes('invalid token') ||
		message.includes('invalid access token') ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('forbidden') ||
		message.includes('access denied') ||
		message.includes('permission denied') ||
		code === 'unauthorized' ||
		code === 'invalid_api_key' ||
		code === 'key_invalid' ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid credential') ||
		message.includes('invalid credentials') ||
		message.includes('bad api key') ||
		message.includes('bad api-key') ||
		message.includes('bad token') ||
		status === 401 ||
		message.includes('status 401') ||
		(code === 'err_bad_request' && status === 401) ||
		(code === 'err_bad_request' && message.includes('unauthorized')) ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('authentication error') ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('unauthorized') ||
		message.includes('not authorized') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('auth error') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('auth failed') ||
		message.includes('invalid credentials') ||
		message.includes('bad api key') ||
		message.includes('expired api key') ||
		status === 401 ||
		status === 403 ||
		code === 'unauthorized' ||
		code === 'forbidden' ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid credential') ||
		message.includes('invalid credentials') ||
		message.includes('bad api key') ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('invalid authorization') ||
		message.includes('authorization failed') ||
		message.includes('invalid bearer token') ||
		message.includes('bad api key') ||
		(status === 401 && !message.includes('rate limit')) ||
		(status === 403 && (message.includes('api key') || message.includes('token') || message.includes('auth') || message.includes('unauthorized')) ) ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('authentication error') ||
		message.includes('bearer token') ||
		message.includes('invalid bearer') ||
		message.includes('malformed authorization header') ||
		message.includes('missing authorization header') ||
		message.includes('unauthorized') ||
		message.includes('unauthenticated') ||
		message.includes('authentication failed') ||
		message.includes('invalid authorization') ||
		message.includes('authentication_error') ||
		message.includes('authentication error') ||
		message.includes('invalid credentials') ||
		message.includes('request failed with status code 401') ||
		message.includes('status code 401') ||
		code === 'key_invalid' ||
		(status === 401 && !message.includes('rate limit')) ||
		message.includes('key_no_quota') ||
		message.includes('authentication failed') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('exceeded your current quota') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('project has exceeded quota') ||
		message.includes('generative language api has not been used') ||
		message.includes('api has not been used in project') ||
		message.includes('is disabled') ||
		message.includes('service disabled') ||
		message.includes('forbidden') ||
		status === 401 ||
		status === 402 ||
		status === 403 ||
		status === 401 ||
		message.includes('status 401') ||
		message.includes('request failed with status code 401') ||
		message.includes(
			'generative language api has not been used in project'
		) ||
		message.includes('it is disabled. enable it by visiting') ||
		message.includes('service_disabled') ||
		(status === 401 && !message.includes('rate limit'))
	);
}

// --- Model Access ---

export function isModelAccessError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (isProviderCapabilityMismatchError(error)) {
		return false;
	}
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

function isProviderCapabilityMismatchError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	if (!message) return false;
	return (
		message.includes('unsupported input mime type for this model') ||
		message.includes('unsupported input mime type') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('function calling is not enabled') ||
		message.includes('tool calling is not supported') ||
		message.includes('tool use is not supported') ||
		message.includes('tools are not supported') ||
		message.includes("does not support 'generatecontent'") ||
		message.includes('does not support "generatecontent"') ||
		message.includes('does not support generatecontent') ||
		message.includes('does not support sendmessage') ||
		message.includes('image generation unavailable in country') ||
		message.includes('image generation unavailable in region') ||
		message.includes('image generation unavailable in provider region') ||
		message.includes('provider_cap_blocked') ||
		message.includes('provider_model_removed') ||
		message.includes('capability blocked') ||
		message.includes('unsupported capability') ||
		message.includes('unsupported modality') ||
		message.includes('unsupported output modality') ||
		message.includes('cannot fetch content from the provided url') ||
		message.includes('failed to fetch content from the provided url') ||
		message.includes('unable to fetch content from the provided url') ||
		message.includes('cannot retrieve content from the provided url') ||
		message.includes('failed to retrieve content from the provided url') ||
		message.includes('unable to retrieve content from the provided url')
	);
}

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
		code === 'key_no_quota' ||
		status === 401 ||
		status === 402 ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('api key not valid') ||
		message.includes('invalid_api_key') ||
		message.includes('api_key_invalid') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('payment required') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('you can find your api key at https://platform.openai.com/account/api-keys') ||
		message.includes('unauthorized') ||
		message.includes('authentication failed')
	);
}

export function isToolUnsupportedError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
	if (!message) return false;
	if (isProviderCapabilityMismatchError(error)) return true;

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
		'audio only',
		'image generation unavailable in country',
		'image generation unavailable in region',
		'image generation unavailable in provider region',
		'provider_cap_blocked',
		'provider_model_removed',
		'capability blocked',
		'capability is blocked',
		'unsupported capability',
		'unsupported modality',
		'unsupported output modality',
		'no endpoints found that support the provided tool_choice value',
		'no endpoints found that support the provided tool choice value',
		'no endpoints found that support the requested capability',
		'no endpoints found that support this capability',
		'provider routing',
		'unavailable in your country',
		'unavailable in your region',
		'not available in your country',
		'not available in your region',
		'cannot fetch content from the provided url',
		'failed to fetch content from the provided url',
		'unable to fetch content from the provided url',
		'cannot retrieve content from the provided url',
		'failed to retrieve content from the provided url',
		'unable to retrieve content from the provided url'
	];

	if (patterns.some(pattern => message.includes(pattern))) return true;
	if (message.includes('tools') && message.includes('not supported'))
		return true;
	if (message.includes('tool use') && message.includes('no endpoints found'))
		return true;
	if (message.includes('output modality') && message.includes('audio'))
		return true;
	if (
		(message.includes('image generation unavailable') ||
			message.includes('image generation unavailable in country') ||
			message.includes('image generation unavailable in region') ||
			message.includes('image generation unavailable in provider region') ||
			message.includes('unavailable in provider region') ||
			message.includes('unavailable in country') ||
			message.includes('unavailable in region') ||
			message.includes('removed in provider region') ||
			message.includes('removed in region') ||
			message.includes('model removed') ||
			message.includes('provider_model_removed') ||
			message.includes('provider_cap_blocked') ||
			message.includes('cap blocked') ||
			message.includes('capability blocked') ||
			message.includes('capability unavailable') ||
			message.includes('capability not available') ||
			message.includes('not available in provider region') ||
			message.includes('not available in country') ||
			message.includes('not available in region')) &&
		(message.includes('image') ||
			message.includes('image_output') ||
			message.includes('capability') ||
			message.includes('provider') ||
			message.includes('region') ||
			message.includes('country') ||
			message.includes('model removed') ||
			message.includes('provider_model_removed') ||
			message.includes('provider_cap_blocked'))
	)
		return true;
	if (
		(message.includes('provider_model_removed') ||
			message.includes('provider_cap_blocked') ||
			message.includes('model removed') ||
			message.includes('capability blocked') ||
			message.includes('cap blocked') ||
			message.includes('capability unavailable') ||
			message.includes('capability not available') ||
			message.includes('image generation unavailable') ||
			message.includes('not available in provider region') ||
			message.includes('not available in region') ||
			message.includes('not available in country') ||
			message.includes('unavailable in provider region') ||
			message.includes('unavailable in region') ||
			message.includes('unavailable in country')) &&
		(message.includes('provider') ||
			message.includes('capability') ||
			message.includes('model') ||
			message.includes('region') ||
			message.includes('country') ||
			message.includes('image_output') ||
			message.includes('image generation'))
	)
		return true;
	if (
		(message.includes('cannot fetch content from the provided url') ||
			message.includes('failed to fetch content from the provided url') ||
			message.includes('unable to fetch content from the provided url') ||
			message.includes('cannot retrieve content from the provided url') ||
			message.includes('failed to retrieve content from the provided url') ||
			message.includes('unable to retrieve content from the provided url')) &&
		(message.includes('provided url') || message.includes('content from'))
	)
		return true;
	const geminiCapabilityMismatch =
		(message.includes('gemini') || message.includes('generatecontent') || message.includes('sendmessage')) &&
		(
			message.includes('unsupported input mime type') ||
			message.includes('audio/s16le') ||
			message.includes('function calling is not enabled') ||
			message.includes('tool calling is not supported') ||
			message.includes('tool use is not supported') ||
			message.includes('tools are not supported') ||
			message.includes('does not support generatecontent') ||
			message.includes('does not support sendmessage')
		);
	const openRouterProviderUnavailable =
		message.includes('no allowed providers are available for the selected model');
	const remoteMediaInputValidationFailure =
		message.includes('cannot fetch content from the provided url') ||
		message.includes('failed to fetch content from the provided url') ||
		message.includes('unable to fetch content from the provided url') ||
		message.includes('does not represent a valid image') ||
		message.includes('invalid image') ||
		message.includes('invalid_value');
	const geminiRegionalOrCapabilityBlock =
		message.includes('image generation unavailable in country') ||
		message.includes('image generation unavailable in provider region') ||
		message.includes('provider region') ||
		message.includes('unavailable in country') ||
		message.includes('unsupported input mime type') ||
		message.includes('unsupported input mime type for this model') ||
		message.includes('audio/s16le') ||
		message.includes('function calling is not enabled') ||
		message.includes('function calling is not enabled for this model') ||
		message.includes('does not support generatecontent') ||
		message.includes('generatecontent unsupported') ||
		message.includes('model does not support generatecontent') ||
		message.includes('does not support sendmessage');
	const providerRetryChurn =
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('timeout: switching provider') ||
		message.includes('switching provider');
	const upstreamAuthOrGovernanceDrift =
		message.includes('generative language api has not been used in project') ||
		message.includes('api has not been used in project') ||
		message.includes('is disabled') ||
		message.includes('forbidden project') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('expired api key') ||
		status === 402 ||
		message.includes('status 402') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		status === 402 ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('quota payment required') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('credits are required') ||
		message.includes('credit balance required') ||
		message.includes('quota payment required') ||
		message.includes('key_no_quota') ||
		status === 402 ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('no credits remaining') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('quota payment required') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('quota payment required') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		status === 402 ||
		message.includes('unauthorized') ||
		message.includes('authentication failed') ||
		message.includes('incorrect api key') ||
		message.includes('key_invalid') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('unauthorized') ||
		message.includes('unauthorised') ||
		message.includes('authentication failed') ||
		message.includes('authentication_error') ||
		message.includes('payment required') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('insufficient_quota') ||
		message.includes('key_no_quota') ||
		message.includes('provider_disabled') ||
		message.includes('access terminated') ||
		status === 401 ||
		status === 402 ||
		message.includes('account not active') ||
		message.includes('project is not permitted') ||
		status === 401 ||
		message.includes('status 401') ||
		status === 403 ||
		message.includes('status 403');
	const upstreamQuotaOrAvailability =
		message.includes('resource has been exhausted') ||
		message.includes('quota exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('billing hard limit') ||
		message.includes('exceeded your current quota') ||
		message.includes('key_no_quota') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('quota exceeded for this provider') ||
		message.includes('provider quota exceeded') ||
		message.includes('quota exceeded for this organization') ||
		message.includes('credit balance is too low') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('project has exceeded quota') ||
		message.includes('quota') && message.includes('openrouter') ||
		message.includes('quota') && message.includes('openai') ||
		message.includes('unauthorized') && message.includes('openrouter') ||
		message.includes('unauthorized') && message.includes('openai') ||
		message.includes('invalid_api_key') && message.includes('openrouter') ||
		message.includes('invalid_api_key') && message.includes('openai') ||
		message.includes('invalid api key') && message.includes('openrouter') ||
		message.includes('invalid api key') && message.includes('openai') ||
		message.includes('key_invalid') && message.includes('openrouter') ||
		message.includes('key_invalid') && message.includes('openai') ||
		status === 402 ||
		message.includes('status 402') ||
		status === 429 ||
		message.includes('status 429') ||
		status === 500 ||
		message.includes('status 500') ||
		status === 503 ||
		message.includes('status 503');
	if (
		message.includes('no endpoints found that support the provided') ||
		message.includes('provider routing') ||
		message.includes('tool_choice value') ||
		message.includes('tool choice must be auto') ||
		message.includes('tool use is not supported') ||
		message.includes('tool calling is not supported') ||
		geminiRegionalOrCapabilityBlock ||
		remoteMediaInputValidationFailure ||
		openRouterProviderUnavailable ||
		geminiCapabilityMismatch ||
		providerRetryChurn ||
		message.includes('returned an empty streaming response') ||
		upstreamAuthOrGovernanceDrift ||
		upstreamQuotaOrAvailability ||
		(status === 404 && !openRouterProviderUnavailable)
	)
		return true;
	return false;
}
