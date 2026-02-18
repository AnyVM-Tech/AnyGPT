import axios from 'axios';

export interface KeyStatus {
  isValid: boolean;
  provider: string;
  tier?: string;
  models?: string[];
  hasQuota?: boolean;
  balance?: number | string;
  rpm?: number;
  tpm?: number;
  orgs?: string[];
  defaultOrg?: string;
  isPozzed?: boolean; // Anthropic
  billingEnabled?: boolean; // Gemini
  isFreeTier?: boolean; // OpenRouter
  raw?: any; // Store raw check data
  error?: string;
}

type ApiErrorInfo = {
  message?: string;
  code?: string;
  type?: string;
  status?: string;
};

const OAI_TIERS: Record<string, { tpm: number; rpm: number }> = {
    'Tier 1': { tpm: 500000, rpm: 500 },
    'Tier 2': { tpm: 1000000, rpm: 5000 },
    'Tier 3': { tpm: 2000000, rpm: 5000 },
    'Tier 4': { tpm: 4000000, rpm: 10000 },
    'Tier 5': { tpm: 40000000, rpm: 15000 }
};

const OAI_RESPONSES_MODEL_PREFERENCE = [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    'gpt-5.2',
    'gpt-5',
    'o3-mini',
    'o3',
    'o1',
    'gpt-4.1-nano',
    'gpt-3.5-turbo'
];

function parseRateLimitHeaders(headers: Record<string, any>): { rpm?: number; tpm?: number } {
    const rpm = parseInt(headers['x-ratelimit-limit-requests'] || '0', 10);
    const tpm = parseInt(headers['x-ratelimit-limit-tokens'] || headers['x-ratelimit-limit-tokens-per-minute'] || '0', 10);
    return {
        rpm: rpm > 0 ? rpm : undefined,
        tpm: tpm > 0 ? tpm : undefined,
    };
}

function pickOpenAIProbeModel(models?: string[]): string | null {
    if (!Array.isArray(models) || models.length === 0) return null;
    for (const candidate of OAI_RESPONSES_MODEL_PREFERENCE) {
        const found = models.find((m) => m === candidate || m.endsWith(`/${candidate}`));
        if (found) return found;
    }
    return models[0] || null;
}

function extractErrorInfo(payload: any): ApiErrorInfo {
    const err = payload?.error || payload;
    if (!err || typeof err !== 'object') return {};
    return {
        message: typeof err.message === 'string' ? err.message : undefined,
        code: typeof err.code === 'string' ? err.code : undefined,
        type: typeof err.type === 'string' ? err.type : undefined,
        status: typeof err.status === 'string' ? err.status : undefined,
    };
}

function isQuotaExhausted(info: ApiErrorInfo): boolean {
    const message = (info.message || '').toLowerCase();
    const code = (info.code || '').toLowerCase();
    const type = (info.type || '').toLowerCase();
    const status = (info.status || '').toLowerCase();

    if (message.includes('rate limit') || message.includes('rate_limit')) return false;
    if (code === 'rate_limit_exceeded' || type === 'rate_limit_exceeded') return false;

    if (code === 'insufficient_quota' || type === 'insufficient_quota') return true;
    if (code === 'billing_hard_limit_reached' || type === 'billing_hard_limit_reached') return true;
    if (code === 'quota_exceeded' || type === 'quota_exceeded') return true;
    if (status === 'resource_exhausted') return true;

    if (message.includes('exceeded your current quota')) return true;
    if (message.includes('quota exceeded')) return true;
    if (message.includes('insufficient quota')) return true;
    if (message.includes('credit balance is too low')) return true;
    if (message.includes('balance is too low')) return true;
    if (message.includes('billing hard limit')) return true;
    if (message.includes('resource exhausted')) return true;
    if (message.includes('insufficient credits')) return true;

    return false;
}

export async function checkOpenAI(apiKey: string): Promise<KeyStatus> {
    const status: KeyStatus = { isValid: false, provider: 'openai', hasQuota: true };
    try {
        // 1. Get Models
        const modelsRes = await axios.get('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            validateStatus: () => true,
            timeout: 10000
        });

        if (modelsRes.status === 401) return { ...status, error: 'Unauthorized' };
        if (modelsRes.status === 200 && modelsRes.data?.data) {
            status.isValid = true;
            status.models = modelsRes.data.data.map((m: any) => m.id);
        } else if (modelsRes.status === 403) {
             // 403 on models might still be usable for chat if project scoped?
             // But usually implies restrictions. We'll mark as valid but limited.
             status.isValid = true; // Maybe?
             status.error = 'Forbidden from listing models';
        }

        // 2. Check Quota / Tier via minimal Responses call (modern endpoint)
        const probeModel = pickOpenAIProbeModel(status.models) || 'gpt-4o-mini';
        const responsesRes = await axios.post(
            'https://api.openai.com/v1/responses',
            {
                model: probeModel,
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
                max_output_tokens: 1,
            },
            { headers: { Authorization: `Bearer ${apiKey}` }, validateStatus: () => true, timeout: 10000 }
        );

        if (responsesRes.status === 401) return { ...status, isValid: false, error: 'Unauthorized' };
        const responsesErr = extractErrorInfo(responsesRes.data);

        const rateLimits = parseRateLimitHeaders(responsesRes.headers || {});
        if (rateLimits.rpm) status.rpm = rateLimits.rpm;
        if (rateLimits.tpm) {
            status.tpm = rateLimits.tpm;
            for (const [tier, limits] of Object.entries(OAI_TIERS)) {
                if (limits.tpm === rateLimits.tpm) {
                    status.tier = tier;
                    break;
                }
            }
            if (!status.tier) status.tier = 'Tier Unknown';
        }

        if (responsesRes.status >= 400) {
            if (isQuotaExhausted(responsesErr)) {
                status.hasQuota = false;
            }
            if (responsesRes.status !== 401) {
                status.isValid = true;
            }
        }
        
        // 3. Check Orgs
        const meRes = await axios.get('https://api.openai.com/v1/me', {
            headers: { Authorization: `Bearer ${apiKey}` },
            validateStatus: () => true,
            timeout: 10000
        });
        if (meRes.status === 200 && meRes.data?.orgs?.data) {
            status.orgs = meRes.data.orgs.data.map((o: any) => o.name);
            const defaultOrg = meRes.data.orgs.data.find((o: any) => o.is_default);
            if (defaultOrg) status.defaultOrg = defaultOrg.name;
        }

    } catch (e: any) {
        status.error = e.message;
    }
    return status;
}

export async function checkAnthropic(apiKey: string): Promise<KeyStatus> {
    const status: KeyStatus = { isValid: false, provider: 'anthropic', hasQuota: true };
    try {
        const res = await axios.post('https://api.anthropic.com/v1/messages', 
            {
                model: 'claude-3-haiku-20240307',
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1
            },
            {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                validateStatus: () => true,
                timeout: 10000
            }
        );

        if (res.status === 200) {
            status.isValid = true;
        } else if (res.status === 400 || res.status === 429) {
             const msg = res.data?.error?.message || '';
             if (msg.includes('credit balance is too low')) status.hasQuota = false;
             if (res.status === 429) status.hasQuota = true; // Rate limited but valid key
             status.isValid = true; // Key worked enough to give specific error
        } else if (res.status === 401) {
            return { ...status, error: 'Unauthorized' };
        }

        const errInfo = extractErrorInfo(res.data);
        if (isQuotaExhausted(errInfo)) {
            status.hasQuota = false;
            status.isValid = true;
        }

        const limit = res.headers['anthropic-ratelimit-requests-limit'];
        if (limit) {
            const rpm = parseInt(limit, 10);
            status.rpm = rpm;
             if (rpm === 5) status.tier = 'Free Tier';
             else if (rpm === 50) status.tier = 'Tier 1';
             else if (rpm === 1000) status.tier = 'Tier 2';
             else if (rpm === 2000) status.tier = 'Tier 3';
             else if (rpm === 4000) status.tier = 'Tier 4';
             else status.tier = 'Scale Tier';
        }

    } catch (e: any) {
        status.error = e.message;
    }
    return status;
}

export async function checkGemini(apiKey: string): Promise<KeyStatus> {
     const status: KeyStatus = { isValid: false, provider: 'gemini', hasQuota: true };
     try {
         const modelsRes = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { validateStatus: () => true, timeout: 10000 });
         if (modelsRes.status === 200 && modelsRes.data?.models) {
             status.isValid = true;
             status.models = modelsRes.data.models.map((m: any) => m.name.replace('models/', ''));
             
             // Check billing via imagen call (from python script)
             const billRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`, 
                { instances: [{ prompt: "" }] },
                { validateStatus: () => true, timeout: 10000 }
             );
             const billErr = extractErrorInfo(billRes.data);
             if (billRes.status === 400) {
                 const msg = billRes.data?.error?.message || '';
                 if (!msg.includes('only accessible to billed users')) {
                     status.billingEnabled = true;
                 } else {
                     status.billingEnabled = false;
                     status.tier = 'Free Tier';
                     status.hasQuota = false;
                 }
             } else if (billRes.status === 429) {
                 status.billingEnabled = false;
                 status.hasQuota = false;
             } else if (billRes.status === 200) {
                 status.billingEnabled = true;
             }
             if (isQuotaExhausted(billErr)) {
                 status.hasQuota = false;
             }
         } else if (modelsRes.status === 429) {
             status.isValid = true;
             status.hasQuota = false;
             status.error = modelsRes.data?.error?.message || 'Gemini quota exceeded';
         } else if (isQuotaExhausted(extractErrorInfo(modelsRes.data))) {
             status.isValid = true;
             status.hasQuota = false;
             status.error = modelsRes.data?.error?.message || 'Gemini quota exceeded';
         } else {
             status.error = modelsRes.data?.error?.message || modelsRes.statusText;
         }
     } catch (e: any) {
         status.error = e.message;
     }
     return status;
}

export async function checkOpenRouter(apiKey: string): Promise<KeyStatus> {
    const status: KeyStatus = { isValid: false, provider: 'openrouter', hasQuota: true };
    try {
        const res = await axios.get('https://openrouter.ai/api/v1/auth/key', {
            headers: { Authorization: `Bearer ${apiKey}` },
            validateStatus: () => true,
            timeout: 10000
        });

        if (res.status === 200 && res.data?.data) {
            status.isValid = true;
            const d = res.data.data;
            const limit = typeof d.limit === 'number' ? d.limit : undefined;
            const usage = typeof d.usage === 'number' ? d.usage : undefined;
            const computedBalance = (limit !== undefined && usage !== undefined) ? (limit - usage) : undefined;
            status.balance = computedBalance;
            status.isFreeTier = d.is_free_tier;
            if (limit !== undefined && usage !== undefined) {
                status.hasQuota = usage < limit;
            }
            const directBalance =
              typeof d.balance === 'number'
                ? d.balance
                : (typeof d.credits === 'number' ? d.credits : undefined);
            if (directBalance !== undefined) {
                status.balance = directBalance;
                if (directBalance <= 0) status.hasQuota = false;
            }
            if (computedBalance !== undefined && computedBalance <= 0) {
                status.hasQuota = false;
            }
            if (d.rate_limit) {
                status.rpm = parseInt(d.rate_limit.requests); // interval usually 10s or 1s? Python script assumes and calcs.
                // We'll just store raw or 0 for now.
            }
        } else if (res.status === 401 || res.status === 403) {
            status.error = 'Unauthorized';
        }
    } catch (e: any) {
        status.error = e.message;
    }
    return status;
}

export async function checkDeepseek(apiKey: string): Promise<KeyStatus> {
    const status: KeyStatus = { isValid: false, provider: 'deepseek', hasQuota: true };
    try {
        const res = await axios.get('https://api.deepseek.com/user/balance', {
             headers: { Authorization: `Bearer ${apiKey}` },
             validateStatus: () => true,
             timeout: 10000
        });
        if (res.status === 200) {
            status.isValid = true;
            const d = res.data;
            if (d.is_available) {
                // Sum balances
                 const total = d.balance_infos?.reduce((acc: number, b: any) => {
                     let amount = parseFloat(b.total_balance);
                     if (b.currency === 'CNY') amount *= 0.14;
                     return acc + amount;
                 }, 0) || 0;
                 status.balance = total;
                 if (total <= 0) status.hasQuota = false;
            } else {
                status.hasQuota = false;
            }
        } else if (res.status === 401 || res.status === 403) {
            status.error = 'Unauthorized';
        } else if (res.status === 402 || res.status === 429) {
            status.isValid = true;
            status.hasQuota = false;
        }
    } catch (e: any) {
        status.error = e.message;
    }
    return status;
}

export async function checkXAI(apiKey: string): Promise<KeyStatus> {
     const status: KeyStatus = { isValid: false, provider: 'xai' };
     try {
         const res = await axios.get('https://api.x.ai/v1/api-key', {
             headers: { Authorization: `Bearer ${apiKey}` },
             validateStatus: () => true,
             timeout: 10000
         });
         if (res.status === 200) {
             const d = res.data;
             if (!d.api_key_disabled && !d.team_blocked) {
                 status.isValid = true;
                 // Validation prompt?
             }
         } else if (res.status === 401 || res.status === 403) {
             status.error = 'Unauthorized';
         }
     } catch (e: any) {
         status.error = e.message;
     }
     return status;
}

export async function checkKey(provider: string, apiKey: string): Promise<KeyStatus> {
    switch (provider.toLowerCase()) {
        case 'openai': return checkOpenAI(apiKey);
        case 'anthropic': return checkAnthropic(apiKey);
        case 'gemini': 
        case 'google': return checkGemini(apiKey);
        case 'openrouter': return checkOpenRouter(apiKey);
        case 'deepseek': return checkDeepseek(apiKey);
        case 'xai': return checkXAI(apiKey);
        default: return { isValid: false, provider, error: 'Unsupported provider for check' };
    }
}
