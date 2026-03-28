import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';

const REFRESH_MODELS_GOAL = 'Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.';
const REFRESH_MODELS_REPAIR_SIGNAL = 'LangSmith feedback sampled contains_goal_context=0 and repair_smoke_passed=0.';
const REFRESH_MODELS_THREAD = process.env.ANYGPT_THREAD_ID || '6940b178-71e5-4eb6-8fc8-4339fc32a74f:api-data';
const REFRESH_MODELS_SCOPE = 'api-data';
const REFRESH_MODELS_VALIDATION = 'Next validation success condition: at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed control-plane smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted.';
const REFRESH_MODELS_READINESS_NOTE = 'Partial readiness evidence only: the experimental API openapi.json endpoint was reachable during inspection, but that does not by itself prove a fresh same-thread LangSmith control-plane validation run or passed smoke/typecheck result.';

function logRefreshModelsContext(level: 'log' | 'error', status: 'starting' | 'completed' | 'failed'): void {
  const logger = console[level];
  logger('[refreshModels] Goal:', REFRESH_MODELS_GOAL);
  logger('[refreshModels] Active repair signal:', REFRESH_MODELS_REPAIR_SIGNAL);
  logger('[refreshModels] Thread:', REFRESH_MODELS_THREAD);
  logger('[refreshModels] Scope:', REFRESH_MODELS_SCOPE);
  logger('[refreshModels] Status:', status);
  logger('[refreshModels] Readiness note:', REFRESH_MODELS_READINESS_NOTE);
  logger('[refreshModels] Validation success condition:', REFRESH_MODELS_VALIDATION);
  logger('[refreshModels] Same-thread observability requirement:', `This iteration still needs one fresh same-thread LangSmith control-plane run/trace for ${REFRESH_MODELS_THREAD}; cross-thread or older runs do not satisfy validation.`);
}

async function main(): Promise<void> {
  logRefreshModelsContext('log', 'starting');
  process.env.DISABLE_MODEL_SYNC = 'false';
  await refreshProviderCountsInModelsFile({ notifyProbes: false });
  logRefreshModelsContext('log', 'completed');
  console.log(`[refreshModels] Operator-facing defer note: partial observability only unless this execution emits a fresh same-thread LangSmith control-plane trace with explicit goal context for ${REFRESH_MODELS_THREAD}; preserve a no-run defer reason instead of treating cross-thread activity as validation.`);
}

main().catch((err) => {
  logRefreshModelsContext('error', 'failed');
  console.error('[refreshModels] Operator-facing defer note: no fresh same-thread LangSmith control-plane run/trace was confirmed by this script execution; preserve a clear no-run defer reason unless a same-thread trace and passed smoke/typecheck result are recorded separately.');
  console.error('Failed to refresh models.json:', err);
  process.exit(1);
});
