/**
 * Shared error classification utilities.
 *
 * Centralises the error-type detection logic that was previously duplicated
 * across providers/handler.ts and routes/openai.ts.
 */

import { containsOpenAiApiKeyHelpLink } from './urlGuards.js';

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
		);
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
		status === 429 ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota remaining') ||
		message.includes('quota limit reached') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this month') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota exceeded for this model') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance') ||
		message.includes('free tier requests') ||
		message.includes('free tier input token count') ||
		message.includes('free tier') ||
		message.includes('payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required for this operation') ||
		message.includes('payment required to access this model') ||
		message.includes('payment required to use this model') ||
		message.includes('payment required to use this provider') ||
		message.includes('payment required to use this endpoint') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for your current plan') ||
		message.includes('quota exceeded for this key') ||
		message.includes('quota exceeded for requests') ||
		message.includes('quota exceeded for tokens') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quota exceeded for metric:') ||
		message.includes('quota exceeded for requests per minute') ||
		message.includes('quota exceeded for requests per day') ||
		message.includes('quota exceeded for input token count') ||
		message.includes('quota exceeded for output token count') ||
		message.includes('key_no_quota') ||
		message.includes('out of credits') ||
		message.includes('credits are exhausted') ||
		message.includes('billing hard limit has been reached') ||
		message.includes('exceeded the prepaid balance') ||
		message.includes('payment method required') ||
		message.includes('payment method is required') ||
		message.includes('402 payment required') ||
		message.includes('quota exceeded for your project') ||
		message.includes('quota exceeded for your account') ||
		message.includes('quota exceeded for organization') ||
		message.includes('quota exceeded for this organization') ||
		message.includes('you exceeded your quota') ||
		message.includes('current quota') ||
		message.includes('billing hard limit') ||
		message.includes('please check your plan and billing details') ||
		message.includes('please check your plan or billing details') ||
		message.includes('please check your billing details') ||
		message.includes('please check your plan') ||
		message.includes('upgrade your plan') ||
		message.includes('add payment details') ||
		message.includes('add a payment method') ||
		message.includes('account balance is too low') ||
		message.includes('out of credits') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quotaid') ||
		message.includes('resource_exhausted') ||
		message.includes('generativelanguage.googleapis.com/generate_content') ||
		message.includes('requests per minute per project per model') ||
		message.includes('requests per day per project per model') ||
		message.includes('free tier input token count') ||
		message.includes('free tier requests') ||
		message.includes('project has been suspended') ||
		message.includes('consumer') && message.includes('has been suspended') ||
		message.includes('api key expired') ||
		message.includes('please renew the api key') ||
		message.includes('generative language api has not been used in project') ||
		message.includes('enable it by visiting') ||
		message.includes('payment required') ||
		message.includes('status code 402') ||
		message.includes('402 payment required') ||
		message.includes('exceeded your quota') ||
		message.includes('out of quota') ||
		message.includes('no quota remaining') ||
		message.includes('credits have been exhausted') ||
		message.includes('credits exhausted') ||
		message.includes('billing hard limit has been reached') ||
		message.includes('billing_not_active') ||
		message.includes('account_not_active') ||
		message.includes('monthly budget has been exceeded') ||
		message.includes('reached your usage limit') ||
		message.includes('usage limit reached') ||
		status === 402 ||
		message.includes('payment required') ||
		message.includes('payment required to use your openrouter account') ||
		message.includes('payment required to use your account') ||
		message.includes('payment required to use this model') ||
		message.includes('unsupported parameter') ||
		message.includes('unsupported value for parameter') ||
		message.includes('parameter is not supported with this model') ||
		message.includes('not supported with this model') ||
		message.includes('does not support parameter') ||
		message.includes('does not support this parameter') ||
		message.includes('model does not support parameter') ||
		message.includes('unsupported setting for this model') ||
		message.includes('temperature is not supported with this model') ||
		message.includes('top_p is not supported with this model') ||
		message.includes('reasoning_effort is not supported with this model') ||
		message.includes('unsupported value for') ||
		message.includes("unsupported parameter: 'temperature'") ||
		message.includes('unsupported parameter: "temperature"') ||
		message.includes('temperature is not supported with this model') ||
		message.includes('temperature is not supported for this model') ||
		message.includes('unsupported value for temperature') ||
		message.includes('unsupported parameter') ||
		message.includes('parameter is not supported with this model') ||
		message.includes('not supported with this model') ||
		message.includes('unsupported tool_choice') ||
		message.includes('tool_choice is not supported') ||
		message.includes('function calling not enabled') ||
		message.includes('payment required to use this provider') ||
		message.includes('payment required to use this endpoint') ||
		message.includes('payment required to use this account') ||
		message.includes('payment required to continue') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance') ||
		message.includes('quota exceeded') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this month') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota exceeded for this model') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this provider') ||
		message.includes('quota exceeded for this account') ||
		message.includes('out of credits') ||
		message.includes('account balance') ||
		message.includes('payment method required') ||
		status === 402 ||
		code === 'insufficient_quota' ||
		message.includes('request failed with status code 402') ||
		message.includes('status code 402') ||
		(status === 402 && (
			message.includes('payment') ||
			message.includes('quota') ||
			message.includes('credit') ||
			message.includes('billing') ||
			message.includes('insufficient')
		)) ||
		message.includes('payment required') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('insufficient quota') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance too low') ||
		message.includes('billing hard limit') ||
		message.includes('billing_not_active') ||
		message.includes('payment') && message.includes('required') ||
		status === 402 ||
		message.includes('request failed with status code 402') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('insufficient balance') ||
		message.includes('account balance is too low') ||
		message.includes('payment method required') ||
		message.includes('billing hard limit has been reached') ||
		message.includes('billing_not_active') ||
		message.includes('credits have been exhausted') ||
		status === 402 ||
		code === 'payment_required'
		message.includes('payment required to use tool calling') ||
		message.includes('payment required for tool calling') ||
		message.includes('payment required for this model') ||
		message.includes('payment required for this provider') ||
		message.includes('payment required for your account') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits remaining') ||
		message.includes('account balance is too low') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		(status === 402) ||
		(code === 'payment_required') ||
		(code === 'insufficient_quota') ||
		(code === 'quota_exceeded') ||
		(code === 'key_no_quota') ||
		message.includes('payment required') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits remaining') ||
		message.includes('account balance is too low') ||
		message.includes('billing hard limit has been reached') ||
		message.includes('recharge your account') ||
		message.includes('add credits to continue') ||
		message.includes('payment required') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('insufficient balance') ||
		message.includes('account balance') ||
		message.includes('credits have been exhausted') ||
		message.includes('credits exhausted') ||
		message.includes('out of credits') ||
		message.includes('no credits remaining') ||
		message.includes('payment required') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota limit reached') ||
		message.includes('quota has been exceeded') ||
		message.includes('out of credits') ||
		message.includes('credit balance') ||
		message.includes('billing hard limit') ||
		message.includes('billing quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('out of credits') ||
		message.includes('account balance') ||
		message.includes('billing hard limit') ||
		message.includes('billing quota') ||
		(status === 402 && (
			message.includes('request failed with status code 402') ||
			code === 'err_bad_request'
		)) ||
		message.includes('payment required') ||
		message.includes('requires a paid account') ||
		message.includes('requires billing') ||
		message.includes('billing hard limit') ||
		message.includes('billing_hard_limit') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		(status === 402 && (
			message.includes('payment') ||
			message.includes('quota') ||
			message.includes('credit') ||
			message.includes('billing') ||
			code.includes('insufficient_quota') ||
			code.includes('payment_required')
		)) ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient credits') ||
		message.includes('credits have been exhausted') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance too low') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('payment method required') ||
		message.includes('billing hard limit') ||
		message.includes('hard limit reached') ||
		message.includes('quota exhausted') ||
		message.includes('quota has been exhausted') ||
		message.includes('no quota remaining') ||
		message.includes('out of credits') ||
		message.includes('out of quota') ||
		message.includes('402 payment required') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('out of credits') ||
		message.includes('out of credit') ||
		message.includes('no credits remaining') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance too low') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('add credits') ||
		message.includes('add credit') ||
		message.includes('purchase credits') ||
		message.includes('billing hard limit') ||
		message.includes('hard limit reached') ||
		message.includes('402 payment required') ||
		status === 402 ||
		message.includes('insufficient_quota') ||
		message.includes('insufficient quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('out of credits') ||
		message.includes('credits have been exhausted') ||
		(status === 402 && (
			message.includes('payment') ||
			message.includes('quota') ||
			message.includes('credit') ||
			code.includes('insufficient_quota')
		)) ||
		message.includes('payment required') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits remaining') ||
		message.includes('account balance is too low') ||
		message.includes('credits remaining') ||
		message.includes('add credits') ||
		message.includes('purchase credits') ||
		message.includes('billing hard limit') ||
		message.includes('hard limit reached') ||
		message.includes('payment method required') ||
		message.includes('request failed with status code 402') ||
		message.includes('status code 402') ||
		message.includes('402 payment required') ||
		message.includes('payment required') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits remaining') ||
		message.includes('credits remaining') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('billing hard limit') ||
		message.includes('billing_hard_limit') ||
		message.includes('billing quota') ||
		message.includes('billing limit') ||
		message.includes('billing disabled') ||
		message.includes('account balance') ||
		message.includes('insufficient balance') ||
		message.includes('payment method') ||
		message.includes('add credits') ||
		message.includes('purchase credits') ||
		status === 402 ||
		message.includes('insufficient_quota') ||
		message.includes('account balance') ||
		message.includes('balance is too low') ||
		message.includes('credits have been exhausted') ||
		message.includes('credits exhausted') ||
		message.includes('payment method') ||
		message.includes('add funds') ||
		status === 402 ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('quota exhausted') ||
		message.includes('quota exhaustion') ||
		message.includes('payment exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('credit balance is too low') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient credits') ||
		message.includes('credits have been exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('billing hard limit') ||
		message.includes('billing quota') ||
		message.includes('account balance') ||
		message.includes('no credits remaining') ||
		message.includes('payment method required') ||
		status === 402 ||
		message.includes('payment method required') ||
		message.includes('payment method is required') ||
		message.includes('billing hard limit') ||
		message.includes('billing quota exceeded') ||
		message.includes('quota payment required') ||
		message.includes('payment has not been configured') ||
		message.includes('payment is required') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quota exceeded for this month') ||
		message.includes('quota exceeded for this day') ||
		message.includes('quota exceeded for this minute') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota limit reached') ||
		message.includes('quota remaining') ||
		message.includes('quotaid') ||
		message.includes('quotametric') ||
		message.includes('retryinfo') ||
		message.includes('retry delay') ||
		message.includes('payment required') ||
		message.includes('payment required to access this model') ||
		message.includes('payment required to use this model') ||
		message.includes('payment required for this request') ||
		message.includes('payment required for this model') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('resource has been exhausted (e.g. check quota).') ||
		message.includes('payment required for this request') ||
		message.includes('resource has been exhausted (e.g. check quota).') ||
		message.includes('resource has been exhausted (e.g. check quota).') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exceeded.') ||
		message.includes('quota exceeded,') ||
		message.includes('quota exceeded:') ||
		message.includes('quota exceeded;') ||
		message.includes('quota exceeded for metric:') ||
		message.includes('limit: 0') ||
		message.includes('retrydelay') ||
		message.includes('retry delay') ||
		message.includes('402 payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('payment method required') ||
		message.includes('payment failed') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('status 402') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('quota payment required') ||
		message.includes('key_no_quota') ||
		message.includes('quota remaining') ||
		message.includes('key_no_quota') ||
		message.includes('provider_no_quota') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('free tier requests') ||
		message.includes('free tier input token count') ||
		message.includes('generativelanguage.googleapis.com/generate_content') ||
		message.includes('generativelanguage.googleapis.com/generate_content_free_tier_requests') ||
		message.includes('generativelanguage.googleapis.com/generate_content_free_tier_input_token_count') ||
		message.includes('quotaid') ||
		message.includes('quotametric') ||
		message.includes('retryinfo') ||
		message.includes('retrydelay') ||
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('unsupported (rate limit/timeout)') ||
		message.includes('provider switch worthless') ||
		message.includes('request retry worthless') ||
		message.includes('retry worthless') ||
		message.includes('rate limit') ||
		message.includes('rate limited') ||
		message.includes('too many requests') ||
		message.includes('billing details') ||
		message.includes('billing hard limit') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this resource') ||
		status === 402 ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment method') ||
		message.includes('payment failed') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('payment is required') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('quota exceeded for metric') ||
		message.includes('free tier requests') ||
		message.includes('free tier request') ||
		message.includes('free tier input token count') ||
		message.includes('free tier') ||
		message.includes('retrydelay') ||
		message.includes('retry delay') ||
		message.includes('generaterequestsperminuteperprojectpermodel-freetier') ||
		message.includes('generaterequestsperdayperprojectpermodel-freetier') ||
		message.includes('generatecontentinputtokenspermodelperminute-freetier') ||
		message.includes('please check your plan and billing details') ||
		message.includes('payment or quota') ||
		message.includes('quota payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('credits are required') ||
		message.includes('credit balance required') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('quota exceeded for metric') ||
		message.includes('free tier requests') ||
		message.includes('free tier input token count') ||
		message.includes('billing hard limit') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		message.includes('billing not active') ||
		message.includes('account not active') ||
		message.includes('insufficient funds') ||
		message.includes('low balance') ||
		message.includes('balance too low') ||
		message.includes('out of credits') ||
		message.includes('out of balance') ||
		message.includes('402 payment') ||
		message.includes('status code 402') ||
		message.includes('no credits left') ||
		message.includes('out of credits') ||
		message.includes('not enough credits') ||
		message.includes('requires credits') ||
		message.includes('requires a paid account') ||
		message.includes('requires payment') ||
		message.includes('add credits') ||
		message.includes('top up your balance') ||
		message.includes('billing issue') ||
		message.includes('payment unavailable') ||
		message.includes('credit balance is insufficient') ||
		message.includes('insufficient funds') ||
		message.includes('out of credits') ||
		message.includes('credits have been exhausted') ||
		message.includes('no credits left') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing limit reached') ||
		message.includes('payment required due to quota') ||
		message.includes('402 payment required') ||
		message.includes('insufficient funds') ||
		message.includes('insufficient credits remaining') ||
		message.includes('no credits remaining') ||
		message.includes('out of credits') ||
		message.includes('account balance too low') ||
		message.includes('balance too low') ||
		message.includes('billing quota exceeded') ||
		message.includes('monthly spend limit reached') ||
		message.includes('spend limit reached') ||
		message.includes('payment required due to insufficient balance') ||
		message.includes('insufficient credits to process request') ||
		message.includes('insufficient credits remaining') ||
		message.includes('credit balance too low') ||
		message.includes('account balance too low') ||
		message.includes('billing quota exceeded') ||
		message.includes('billing hard limit reached') ||
		message.includes('payment required by provider') ||
		message.includes('provider requires payment') ||
		message.includes('insufficient funds') ||
		message.includes('insufficient credits remaining') ||
		message.includes('out of credits') ||
		message.includes('no credits remaining') ||
		message.includes('account balance too low') ||
		message.includes('balance too low') ||
		message.includes('billing quota exceeded') ||
		message.includes('monthly quota exceeded') ||
		message.includes('usage limit reached') ||
		message.includes('spending limit reached') ||
		message.includes('402 payment required') ||
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
		message.includes('billing details') ||
		message.includes('check your plan and billing details') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment method') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('payment is required') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing hard limit') ||
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
		message.includes('payment required') ||
		message.includes('status 402') ||
		message.includes('status code 402') ||
		message.includes('402 payment required') ||
		message.includes('request failed with status code 402') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('quota has been exceeded') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment method required') ||
		message.includes('payment method') ||
		message.includes('payment is required') ||
		message.includes('payment is required to use this model') ||
		message.includes('payment is required to use this provider') ||
		message.includes('payment required to use this model') ||
		message.includes('payment required to use this provider') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance too low') ||
		message.includes('credits are exhausted') ||
		message.includes('credits exhausted') ||
		message.includes('out of credits') ||
		message.includes('quota exceeded') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('quota exceeded for this project') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('key_no_quota')
	);
}

// --- Invalid Credentials ---

function includesAnyText(haystack: string, needles: string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

function collectWrappedProviderSummary(error: any): string {
	return String(
		error?.lastProviderErrorSummary ||
			error?.lastProviderError ||
			error?.errorDetails?.lastProviderErrorSummary ||
			error?.errorDetails?.lastProviderError ||
			error?.errorDetails?.providerErrorSummary ||
			error?.errorDetails?.providerError ||
			error?.errorDetails?.cause ||
			error?.response?.data?.error?.message ||
			error?.response?.data?.message ||
			error?.error?.message ||
			error?.cause?.message ||
			error?.cause ||
			error?.stack ||
			''
	).toLowerCase();
}

export function isInvalidProviderCredentialError(error: any): boolean {
	const message = String(error?.message || error || '').toLowerCase();
	const status = Number((error as any)?.status || (error as any)?.statusCode || (error as any)?.response?.status || 0);
	const code = String((error as any)?.code || (error as any)?.error?.code || (error as any)?.response?.data?.error?.code || '').toLowerCase();
	const errorType = String((error as any)?.type || (error as any)?.error?.type || (error as any)?.response?.data?.error?.type || '').toLowerCase();
	const providerStatus = String((error as any)?.error?.status || (error as any)?.response?.data?.error?.status || '').toLowerCase();
	const wrappedProviderSummary = collectWrappedProviderSummary(error);
	const lastProviderError = String(
		(error as any)?.lastProviderError ||
		(error as any)?.errorDetails?.lastProviderError ||
		(error as any)?.errorDetails?.lastProviderErrorSummary ||
		(error as any)?.lastError ||
		''
	).toLowerCase();
	const combinedMessage = [message, wrappedProviderSummary, lastProviderError].filter(Boolean).join('\n');
	if (!combinedMessage && status === 0 && !code && !errorType && !providerStatus) return false;

	const authTerms = [
		'incorrect api key provided',
		'invalid api key',
		'invalid_api_key',
		'invalid api-key',
		'invalid authentication',
		'invalid authentication credentials',
		'authentication failed',
		'authentication error',
		'authentication_error',
		'unauthorized',
		'unauthorised',
		'unauthenticated',
		'not authorized',
		'not authorised',
		'permission denied',
		'forbidden',
		'api key not found',
		'api key not valid',
		'api key is invalid',
		'the api key is invalid',
		'key_invalid',
		'key invalid',
		'invalid key',
		'invalid credentials',
		'invalid token',
		'invalid bearer token',
		'bad api key',
		'incorrect api key',
		'missing api key',
		'missing authentication',
		'missing credentials',
		'access denied',
		'access forbidden',
		'authorization failed',
		'authorization error',
		'the provided api key is invalid',
		'api key provided is invalid',
		'api key has expired',
		'expired api key',
		'invalid credentials',
		'invalid credential',
		'invalid token',
		'invalid access token',
		'access token is invalid',
		'invalid bearer token',
		'invalid bearer [redacted]',
		'malformed authorization header',
		'authorization header',
		"you didn't provide an api key",
		'you did not provide an api key',
		'no api key provided',
		'invalid or missing api key',
		'api key provided',
		'you can find your api key at',
	];
	const authCodes = new Set([
		'invalid_api_key', 'invalid key', 'invalid_key', 'key_invalid', 'invalidapikey', 'invalidtoken', 'invalid_token',
		'unauthorized', 'forbidden', 'permission_denied', 'auth_error', 'auth_failed', 'invalid_auth',
		'invalid_authentication', 'invalid_credential', 'invalid_credentials', 'authenticationerror',
		'authentication_error', 'authentication_failed', 'unauthenticated', 'invalid_request_error',
		'incorrect_api_key', 'api_key_invalid', 'api_key_not_found', 'api_key_not_valid', 'bad_api_key',
		'bad_api_token', 'invalid_api_token', 'invalid_auth_token', 'invalid_bearer_token',
		'invalid_signature', 'signature_invalid', 'access_denied', 'accessdenied', 'organization_deactivated', 'account_deactivated',
	]);
	const authErrorTypes = new Set(['invalid_api_key', 'authentication_error', 'authenticationerror', 'authenticationfailed', 'invalid_request_error']);
	const providerStatuses = new Set(['permission_denied', 'unauthenticated', 'unauthorized', 'forbidden']);
	const wrappedProviderFailureContext =
		Boolean((error as any)?.lastProviderId) ||
		Boolean((error as any)?.errorDetails?.lastProviderId) ||
		Boolean((error as any)?.errorDetails?.lastProviderErrorSummary) ||
		Boolean((error as any)?.errorDetails?.lastProviderError) ||
		Boolean((error as any)?.lastProviderErrorSummary) ||
		Boolean((error as any)?.lastProviderError) ||
		includesAnyText(message, [
			'failed to process request after',
			'failed to process request:',
			'provider attempt(s)',
			'provider attempts',
			'all failed',
			'last provider:',
			'last provider error',
			'last provider error summary',
			'lastprovidererror',
			'lastprovidererrorsummary',
			'last error:',
			'cause:',
			'api call failed:',
			'gemini api call failed:',
			'openai api call failed:',
			'request failed with status code 401',
			'status code 401',
		]);

	return (
		status === 401 ||
		status === 403 ||
		authCodes.has(code) ||
		authErrorTypes.has(errorType) ||
		providerStatuses.has(providerStatus) ||
		includesAnyText(message, authTerms) ||
		includesAnyText(wrappedProviderSummary, authTerms) ||
		(message.includes('api key provided') && (message.includes('incorrect') || message.includes('invalid'))) ||
		(wrappedProviderFailureContext && includesAnyText(`${message} | ${wrappedProviderSummary}`, [
			'api key',
			'access token',
			'bearer token',
			'unauthorized',
			'authentication',
			'invalid_request_error',
		])) ||
		containsOpenAiApiKeyHelpLink(message)
	);
}
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
	const status = Number((error as any)?.status || (error as any)?.statusCode || (error as any)?.response?.status || 0);
	const code = String((error as any)?.code || (error as any)?.error?.code || '').toLowerCase();
	const errorType = String((error as any)?.type || (error as any)?.error?.type || '').toLowerCase();
	const wrappedProviderSummary = String(
		(error as any)?.lastProviderErrorSummary ||
		(error as any)?.lastProviderError ||
		(error as any)?.errorDetails?.lastProviderErrorSummary ||
		(error as any)?.errorDetails?.lastProviderError ||
		(error as any)?.cause?.message ||
		''
	).toLowerCase();
	const aggregatedProviderFailureWrapper =
		message.includes('failed to process request after') ||
		message.includes('failed to process request:') ||
		message.includes('provider attempt(s)') ||
		message.includes('provider attempts') ||
		message.includes('all failed') ||
		message.includes('last provider:') ||
		message.includes('cause:') ||
		message.includes('last error:') ||
		message.includes('last provider error summary') ||
		message.includes('lastprovidererrorsummary') ||
		message.includes('last provider error') ||
		message.includes('lastprovidererror') ||
		message.includes('all skipped by rate limit') ||
		wrappedProviderSummary.includes('you exceeded your current quota') ||
		wrappedProviderSummary.includes('exceeded your current quota') ||
		wrappedProviderSummary.includes('insufficient_quota') ||
		wrappedProviderSummary.includes('quota exceeded') ||
		wrappedProviderSummary.includes('quota exhausted') ||
		wrappedProviderSummary.includes('resource has been exhausted') ||
		wrappedProviderSummary.includes('resource exhausted') ||
		wrappedProviderSummary.includes('resource_exhausted') ||
		wrappedProviderSummary.includes('billing details') ||
		wrappedProviderSummary.includes('payment required') ||
		wrappedProviderSummary.includes('invalid api key') ||
		wrappedProviderSummary.includes('invalid_api_key') ||
		wrappedProviderSummary.includes('unauthorized') ||
		wrappedProviderSummary.includes('authentication failed') ||
		message.includes('temporarily unavailable') ||
		message.includes('try again shortly') ||
		message.includes('rate-limited/cooling down') ||
		message.includes('rate limit scheduled') ||
		message.includes('temporarily unavailable') ||
		Boolean((error as any)?.lastProviderId) ||
		Boolean((error as any)?.lastProviderError) ||
		Boolean((error as any)?.lastProviderErrorSummary) ||
		Boolean((error as any)?.errorDetails?.lastProviderId) ||
		Boolean((error as any)?.errorDetails?.lastProviderError) ||
		Boolean((error as any)?.errorDetails?.lastProviderErrorSummary);		message.includes('unsupported parameter') ||
		message.includes('not supported with this model') ||
		message.includes('invalid_request_error') ||
		message.includes('resource has been exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('unauthorized') ||
		message.includes('invalid_api_key') ||
		message.includes('key_invalid') ||
		message.includes('401') ||
		message.includes('402');
		Boolean((error as any)?.errorDetails?.lastProviderId) ||
		Boolean((error as any)?.errorDetails?.attemptedProviders);
	const wrappedAuthOrQuotaSignal =
		wrappedProviderSummary.includes('invalid_api_key') ||
		wrappedProviderSummary.includes('incorrect api key provided') ||
		wrappedProviderSummary.includes('api key not found') ||
		wrappedProviderSummary.includes('api key not valid') ||
		wrappedProviderSummary.includes('api key expired') ||
		wrappedProviderSummary.includes('unauthorized') ||
		wrappedProviderSummary.includes('authentication error') ||
		wrappedProviderSummary.includes('authentication failed') ||
		wrappedProviderSummary.includes('invalid credentials') ||
		wrappedProviderSummary.includes('invalid credential') ||
		wrappedProviderSummary.includes('permission denied') ||
		wrappedProviderSummary.includes('forbidden') ||
		wrappedProviderSummary.includes('payment required') ||
		wrappedProviderSummary.includes('insufficient_quota') ||
		wrappedProviderSummary.includes('billing_hard_limit_reached') ||
		wrappedProviderSummary.includes('key_no_quota') ||
		wrappedProviderSummary.includes('quota exceeded') ||
		wrappedProviderSummary.includes('resource has been exhausted') ||
		wrappedProviderSummary.includes('resource exhausted') ||
		wrappedProviderSummary.includes('resource_exhausted') ||
		wrappedProviderSummary.includes('check your plan and billing details') ||
		wrappedProviderSummary.includes('billing details');
	if (!message && status === 0 && !code && !errorType && !wrappedProviderSummary) return false;
	return (
		status === 401 ||
		status === 402 ||
		status === 403 ||
		(aggregatedProviderFailureWrapper && wrappedAuthOrQuotaSignal) ||
		code === 'invalid_api_key' ||
		code === 'invalid key' ||
		code === 'invalid_key' ||
		code === 'key_invalid' ||
		code === 'unauthorized' ||
		code === 'forbidden' ||
		code === 'permission_denied' ||
		code === 'auth_error' ||
		code === 'invalid_auth' ||
		code === 'invalid_authentication' ||
		code === 'invalid_credential' ||
		code === 'invalid_credentials' ||
		code === 'payment_required' ||
		code === 'insufficient_quota' ||
		code === 'billing_hard_limit_reached' ||
		code === 'key_no_quota' ||
		errorType === 'invalid_api_key' ||
		errorType === 'invalid_request_error' ||
		errorType === 'authentication_error' ||
		message.includes('api key not found') ||
		message.includes('api key not valid') ||
		message.includes('api key expired') ||
		message.includes('please renew the api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('payment required') ||
		message.includes('billing details') ||
		message.includes('check your plan and billing details') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('quota exceeded') ||
		message.includes('key_no_quota') ||		message.includes('payment required to use your account') ||
		message.includes('payment required to continue') ||
		message.includes('requires a paid account') ||
		message.includes('requires billing') ||
		message.includes('billing hard limit') ||
		message.includes('billing_hard_limit') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('payment required') ||
		message.includes('requires a paid account') ||
		message.includes('requires billing') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('authorization header is missing') ||
		message.includes('authorization header missing') ||
		message.includes('invalid authorization header') ||
		message.includes('authentication credentials were not provided') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing has not been enabled') ||
		message.includes('billing details') ||
		message.includes('billing hard limit') ||
		message.includes('billing account') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('requires a paid account') ||
		message.includes('requires billing') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('credit balance') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('payment declined') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient balance') ||
		message.includes('insufficient credits remaining') ||
		message.includes('credit balance is too low') ||
		message.includes('account balance is too low') ||
		message.includes('balance is too low') ||
		message.includes('key_no_quota') ||
		message.includes('request failed with status code 401') ||
		message.includes('request failed with status code 402') ||
		message.includes('status code 401') ||
		message.includes('status code 402') ||
		message.includes('err_bad_request') ||
		message.includes('authorization header') ||
		message.includes('bearer token') ||
		message.includes('api key provided is invalid') ||
		message.includes('the api key you provided is invalid') ||
		message.includes('key_invalid') ||
		message.includes('key_no_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('insufficient balance') ||
		message.includes('balance is too low') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing hard limit') ||
		message.includes('billing_hard_limit') ||
		message.includes('insufficient_quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('you exceeded your current quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('invalid_request_error') ||
		message.includes('timeout of ') ||
		message.includes('request timed out') ||
		message.includes('upstream request timeout') ||
		message.includes('provider timeout') ||
		message.includes('quota exceeded') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('quota exceeded for metric') ||
		message.includes('quota limit reached') ||
		message.includes('quota exhausted') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('key_no_quota') ||
		message.includes('retryinfo') ||
		message.includes('retry delay') ||
		message.includes('quota exceeded') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this model') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('quotaid') ||
		message.includes('quotametric') ||
		message.includes('retryinfo') ||
		message.includes('retry delay') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exceeded for metric') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota limit reached') ||
		message.includes('quota has been exceeded') ||
		message.includes('quota exceeded for this request') ||
		message.includes('quota exceeded for this project') ||
		message.includes('quota exceeded for this model') ||
		message.includes('quota exceeded for metric') ||
		message.includes('you exceeded your current quota') ||
		message.includes('exceeded your current quota') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource has been exhausted (e.g. check quota)') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('provider_no_quota') ||
		status === 401 ||
		status === 402 ||
		code === 'invalid_api_key' ||
		containsOpenAiApiKeyHelpLink(message)
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
			containsOpenAiApiKeyHelpLink(message)
		)) ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('invalid_api_key') ||
		message.includes('api key not found') ||
		message.includes('api_key_invalid') ||
		message.includes('api key expired') ||
		message.includes('api key not valid') ||
		containsOpenAiApiKeyHelpLink(message)
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
		code === 'insufficient_quota' ||
		status === 401 ||
		status === 402 ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('api key not valid') ||
		message.includes('invalid_api_key') ||
		message.includes('api_key_invalid') ||
		message.includes('key_no_quota') ||
		message.includes('insufficient_quota') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('billing details') ||
		message.includes('billing account') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('payment required') ||
		message.includes('payment method required') ||
		message.includes('payment method') ||
		message.includes('billing disabled') ||
		message.includes('billing has been disabled') ||
		containsOpenAiApiKeyHelpLink(message) ||
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
	const wrappedProviderSummary = String(
		(error as any)?.lastProviderErrorSummary ||
		(error as any)?.lastProviderError ||
		(error as any)?.errorDetails?.lastProviderErrorSummary ||
		(error as any)?.errorDetails?.lastProviderError ||
		(error as any)?.cause?.message ||
		''
	).toLowerCase();
	const aggregatedProviderTimeoutWrapper =
		(message.includes('failed to process request after ') ||
			message.includes('failed to process request:')) &&
		(message.includes('provider attempt(s)') ||
			message.includes('provider attempts') ||
			message.includes('all failed') ||
			message.includes('last provider:') ||
			message.includes('cause:') ||
			message.includes('last error:') ||
			message.includes('last provider error') ||
			message.includes('last provider error summary') ||
			message.includes('lastprovidererrorsummary') ||
			message.includes('lastprovidererror') ||
			message.includes('timeout of <duration> exceeded') ||
			message.includes('timed out') ||
			message.includes('timeout exceeded') ||
			message.includes('request timed out') ||
			message.includes('operation timed out') ||
			message.includes('all failed') ||
			message.includes('cause:') ||
			message.includes('api call failed: timeout') ||
			wrappedProviderSummary.includes('timeout of <duration> exceeded') ||
			wrappedProviderSummary.includes('timed out') ||
			wrappedProviderSummary.includes('timeout exceeded') ||
			wrappedProviderSummary.includes('request timed out') ||
			wrappedProviderSummary.includes('operation timed out') ||
			wrappedProviderSummary.includes('api call failed: timeout') ||
			wrappedProviderSummary.includes('request timed out') ||
			wrappedProviderSummary.includes('operation timed out') ||
			String((error as any)?.errorDetails?.failureOrigin || '').toLowerCase() === 'upstream_provider' ||
			message.includes('last error:')) &&
		(
			message.includes('cause: api call failed: timeout') ||
			message.includes('cause: api call failed: timed out') ||
			wrappedProviderSummary.includes('api call failed: timeout') ||
			wrappedProviderSummary.includes('api call failed: timed out') ||
			message.includes('cause: timeout of ') ||
			message.includes('cause: request timed out') ||
			message.includes('cause: timed out') ||
			message.includes('last error: api call failed: timeout') ||
			message.includes('last error: api call failed: timed out') ||
			wrappedProviderSummary.includes('timeout of ') ||
			wrappedProviderSummary.includes('timed out') ||
			wrappedProviderSummary.includes('timeout exceeded'));
	const providerRetryChurn =
		aggregatedProviderTimeoutWrapper ||
		message.includes('rate limit/timeout: switching provider') ||
		message.includes('timeout: switching provider') ||
		message.includes('switching provider') ||
		message.includes('failed to process request after ') ||
		message.includes('provider attempt(s)') ||
		message.includes('provider attempts') ||
		message.includes('last provider:') ||
		message.includes('cause: api call failed: timeout') ||
		message.includes('cause: api call failed: timed out') ||
		message.includes('cause: timeout of <duration> exceeded') ||
		wrappedProviderSummary.includes('api call failed: timeout') ||
		wrappedProviderSummary.includes('api call failed: timed out') ||
		wrappedProviderSummary.includes('timeout of <duration> exceeded') ||
		wrappedProviderSummary.includes('request timed out') ||
		wrappedProviderSummary.includes('rate limit/timeout: switching provider') ||
		wrappedProviderSummary.includes('switching provider') ||
		Boolean((error as any)?.errorDetails?.lastProviderId) ||
		Number((error as any)?.errorDetails?.skippedByProviderRateLimit || 0) > 0 ||
		message.includes('cause: request timed out') ||
		message.includes('last provider error summary') ||
		message.includes('failed to process request after') ||
		message.includes('provider attempt(s)') ||
		message.includes('provider attempts') ||
		message.includes('last provider:') ||
		message.includes('last provider error:') ||
		message.includes('lastprovidererrorsummary') ||
		message.includes('last provider error summary') ||
		message.includes('api call failed: timeout') ||
		message.includes('api call failed: timed out') ||
		message.includes('timeout of <duration> exceeded') ||
		message.includes('timeout exceeded') ||
		message.includes('unsupported parameter') ||
		message.includes('is not supported with this model') ||
		message.includes('not supported with this model') ||
		message.includes('unsupported value for') ||
		message.includes('does not support this parameter') ||
		message.includes('request timed out') ||
		message.includes('upstream request timed out') ||
		message.includes('timeout of ') ||
		message.includes('etimedout') ||
		message.includes('econnreset') ||
		message.includes('socket hang up') ||
		message.includes('timed out') ||
		message.includes('timedout') ||
		message.includes('etimedout') ||
		message.includes('econnaborted') ||
		message.includes('request timeout') ||
		message.includes('request timed out') ||
		message.includes('upstream request timeout') ||
		message.includes('upstream timed out') ||
		message.includes('upstream timeout') ||
		message.includes('timeout of <duration> exceeded') ||
		message.includes('timeout exceeded') ||
		message.includes('timed out after') ||
		message.includes('failed to process request after') ||
		message.includes('timeout of') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('operation timed out') ||
		message.includes('connection timed out') ||
		message.includes('read timed out') ||
		message.includes('socket hang up') ||
		message.includes('timeout of <duration> exceeded') ||
		message.includes('timeout exceeded') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('api call failed: timeout') ||
		message.includes('timeout of ') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('socket hang up') ||
		message.includes('etimedout') ||
		message.includes('api call failed: timeout') ||
		message.includes('timeout of ') ||
		message.includes('timed out') ||
		message.includes('etimedout') ||
		message.includes('api call failed: timeout') ||
		message.includes('timeout of ') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('timeout of ') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('operation timed out') ||
		message.includes('socket hang up') ||
		message.includes('etimedout') ||
		message.includes('econnaborted') ||
		message.includes('timeout of ') ||
		message.includes('timed out after') ||
		message.includes('request timed out') ||
		message.includes('request timeout') ||
		message.includes('api call failed: timeout') ||
		message.includes('timeout of ') ||
		message.includes('timed out') ||
		message.includes('etimedout') ||
		message.includes('econnaborted') ||
		message.includes('socket hang up') ||
		message.includes('request failed with status code 401') ||
		message.includes('request failed with status code 402') ||
		message.includes('status code 401') ||
		message.includes('status code 402') ||
		message.includes('invalid_api_key') ||
		message.includes('invalid api key') ||
		message.includes('incorrect api key provided') ||
		message.includes('unauthorized') ||
		message.includes('payment required') ||
		message.includes('quota exceeded') ||
		message.includes('insufficient credits') ||
		message.includes('credit balance is too low') ||
		message.includes('upstream timed out after') ||
		message.includes('api call failed: timeout') ||
		message.includes('api call failed: timed out') ||
		message.includes('api call failed: timeout of') ||
		message.includes('provider request timed out') ||
		message.includes('provider timeout') ||
		message.includes('axioserror: timeout') ||
		message.includes('timeout exceeded') ||
		message.includes('deadline exceeded');
	const upstreamAuthOrGovernanceDrift =
		providerRetryChurn ||
		message.includes('generative language api has not been used in project') ||
		message.includes('api has not been used in project') ||
		message.includes('is disabled') ||
		message.includes('forbidden project') ||
		message.includes('invalid_api_key') ||
		message.includes('api_key_invalid') ||
		message.includes('incorrect api key provided') ||
		message.includes('unauthorized') ||
		message.includes('payment required') ||
		message.includes('status code 402') ||
		message.includes('request failed with status code 402') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('key_no_quota') ||
		message.includes('invalid api key') ||
		message.includes('invalid_api_key') ||
		message.includes('expired api key') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('you exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('quota exceeded for metric') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment method required') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('you exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('quota exceeded for metric') ||
		message.includes('payment required') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('payment declined') ||
		message.includes('you exceeded your current quota') ||
		message.includes('check your plan and billing details') ||
		message.includes('resource has been exhausted') ||
		message.includes('resource exhausted') ||
		message.includes('resource_exhausted') ||
		message.includes('quota exceeded') ||
		message.includes('quota exhausted') ||
		message.includes('payment required') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient balance') ||
		message.includes('payment required') ||
		message.includes('provider payment required') ||
		message.includes('payment required for this request') ||
		message.includes('payment required to access this model') ||
		message.includes('payment method required') ||
		message.includes('payment overdue') ||
		message.includes('insufficient credits') ||
		message.includes('insufficient credit') ||
		message.includes('insufficient balance') ||
		message.includes('credit balance is too low') ||
		message.includes('credits exhausted') ||
		message.includes('credit balance exhausted') ||
		message.includes('quota payment required') ||
		message.includes('status code 402') ||
		message.includes('status 402') ||
		message.includes('payment required') ||
		message.includes('quota payment required') ||
		message.includes('provider payment required') ||
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
