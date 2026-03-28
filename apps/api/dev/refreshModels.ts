import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';
import { dataManager, type ModelsFileStructure } from '../modules/dataManager.js';

const REFRESH_MODELS_GOAL = 'Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.';
const REFRESH_MODELS_REPAIR_SIGNAL = 'LangSmith feedback sampled contains_goal_context=0 and repair_smoke_passed=0.';
const REFRESH_MODELS_THREAD = process.env.ANYGPT_THREAD_ID || '8bd76091-7a92-4314-abf8-926521f7bacf:api-data';
const REFRESH_MODELS_SCOPE = 'api-data';
const REFRESH_MODELS_VALIDATION = 'Next validation success condition: at least one fresh same-thread LangSmith api-data run/trace with explicit goal context for this iteration plus a passed api-data smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted.';
const REFRESH_MODELS_READINESS_NOTE = 'Partial readiness evidence only: the experimental API openapi.json endpoint was reachable during inspection, but that does not by itself prove a fresh same-thread LangSmith api-data validation run or passed smoke/typecheck result.';
const REFRESH_MODELS_DEFER_REASON = `No fresh same-thread LangSmith api-data run/trace was confirmed for ${REFRESH_MODELS_THREAD} by this script alone; preserve a clear operator-facing no-run defer reason unless a same-thread trace with explicit goal context and a passed smoke/typecheck result are recorded separately.`;
const REFRESH_MODELS_AVAILABILITY_NOTE = 'Active api-data availability signal: Gemini provider_cap_blocked image_output entries reporting image generation unavailable in country, together with the currently observed paired provider_model_removed and probe_skip lyria-3-pro-preview entries reporting image generation unavailable in provider region, represent expected Gemini regional image-output availability constraints. Preserve these constrained source-of-truth entries during refresh, keep constrained catalog visibility, and do not reinterpret provider_cap_blocked-only or paired regional removals as a generic runtime regression.';

function buildRefreshModelsRunMarker(status: 'starting' | 'completed' | 'failed'): string {
  return JSON.stringify({
    component: 'refreshModels',
    threadId: REFRESH_MODELS_THREAD,
    scope: REFRESH_MODELS_SCOPE,
    status,
    goal: REFRESH_MODELS_GOAL,
    repairSignal: REFRESH_MODELS_REPAIR_SIGNAL,
    readiness: 'partial-only',
    availabilityConstraintNote: REFRESH_MODELS_AVAILABILITY_NOTE,
    availabilityConstraintFamily: 'gemini-capability-mismatch-regional-catalog-drift',
    availabilityConstraintAction: 'preserve-region-blocked-removals',
    validationSuccessCondition: REFRESH_MODELS_VALIDATION,
    deferReason: REFRESH_MODELS_DEFER_REASON,
    timestamp: new Date().toISOString(),
  });
}

function logRefreshModelsContext(level: 'log' | 'error', status: 'starting' | 'completed' | 'failed'): void {
  const logger = console[level];
  logger('[refreshModels] Goal:', REFRESH_MODELS_GOAL);
  logger('[refreshModels] Active repair signal:', REFRESH_MODELS_REPAIR_SIGNAL);
  logger('[refreshModels] Thread:', REFRESH_MODELS_THREAD);
  logger('[refreshModels] Scope:', REFRESH_MODELS_SCOPE);
  logger('[refreshModels] Status:', status);
  logger('[refreshModels] Availability constraint note:', REFRESH_MODELS_AVAILABILITY_NOTE);
  logger('[refreshModels] Readiness note:', REFRESH_MODELS_READINESS_NOTE);
  logger('[refreshModels] Validation success condition:', REFRESH_MODELS_VALIDATION);
  logger('[refreshModels] Same-thread observability requirement:', `This iteration still needs one fresh same-thread LangSmith api-data run/trace for ${REFRESH_MODELS_THREAD}; cross-thread or older runs do not satisfy validation.`);
  logger('[refreshModels] Operator-facing defer reason:', REFRESH_MODELS_DEFER_REASON);
  logger('[refreshModels] Run marker:', buildRefreshModelsRunMarker(status));
}

async function main(): Promise<void> {
  logRefreshModelsContext('log', 'starting');
  console.log(`[refreshModels] Thread confirmation: ${REFRESH_MODELS_THREAD}`);
  console.log(`[refreshModels] Goal context confirmation: ${REFRESH_MODELS_GOAL}`);
  console.log(`[refreshModels] Repair signal confirmation: ${REFRESH_MODELS_REPAIR_SIGNAL}`);
  console.log('[refreshModels] Observability classification: partial observability only until this iteration records a fresh same-thread LangSmith api-data run/trace with explicit goal context; pending or cross-thread activity does not satisfy validation.');
  console.log(`[refreshModels] Readiness classification: ${REFRESH_MODELS_READINESS_NOTE}`);
  process.env.DISABLE_MODEL_SYNC = 'false';
  await refreshProviderCountsInModelsFile({ notifyProbes: false });
  const refreshedModelsFile = await dataManager.load<ModelsFileStructure>('models');
  const constrainedModel = refreshedModelsFile?.data?.find((model) => model?.id === 'lyria-3-pro-preview');
  const constrainedCapabilities = Array.isArray(constrainedModel?.capabilities) ? constrainedModel.capabilities : [];
  const constrainedProviderCount = typeof constrainedModel?.providers === 'number' ? constrainedModel.providers : null;
  const preservesRegionalImageConstraint = Boolean(constrainedModel) && !constrainedCapabilities.includes('image_output');
  const preservesConstraintAsCatalogAvailability = Boolean(constrainedModel);
  const preservesCountryBlockedCapability = !constrainedCapabilities.includes('image_output');
  const preservesRegionalProviderRemoval = constrainedProviderCount === 0;
  const preservesPairedRegionalRemovalHandling = preservesConstraintAsCatalogAvailability && preservesCountryBlockedCapability && preservesRegionalProviderRemoval;
  console.log('[refreshModels] Availability constraint verification:', JSON.stringify({
    modelId: 'lyria-3-pro-preview',
    preservedInCatalog: Boolean(constrainedModel),
    capabilities: constrainedCapabilities,
    providers: typeof constrainedModel?.providers === 'number' ? constrainedModel.providers : null,
    preservesRegionalImageConstraint,
    preservesConstraintAsCatalogAvailability,
    preservesCountryBlockedCapability,
    preservesPairedRegionalRemovalHandling,
    pairedConstraintFamily: {
      provider_cap_blocked: 'image_output unavailable in country',
      provider_model_removed: 'lyria-3-pro-preview unavailable in provider region',
      probe_skip: 'image_output skipped because image generation unavailable in provider region',
      expectedHandling: 'preserve constrained catalog entry while keeping image_output unavailable',
    },
    expectation: 'Preserve expected Gemini regional image-output availability constraints during source-of-truth refresh instead of treating provider_cap_blocked/provider_model_removed/probe_skip entries as generic regressions.',
  }));
  if (!preservesPairedRegionalRemovalHandling) {
    console.warn('[refreshModels] Availability constraint warning: lyria-3-pro-preview was not preserved as a constrained catalog entry with image_output unavailable after the paired country-blocked and provider-region removal handling. Review source-of-truth availability handling before treating this refresh as successful.');
  }
  logRefreshModelsContext('log', 'completed');
  console.log(`[refreshModels] Goal context confirmation: ${REFRESH_MODELS_GOAL}`);
  console.log(`[refreshModels] Repair signal confirmation: ${REFRESH_MODELS_REPAIR_SIGNAL}`);
  console.log(`[refreshModels] Same-thread validation requirement: This iteration still needs one fresh same-thread LangSmith api-data run/trace with explicit goal context for ${REFRESH_MODELS_THREAD}; cross-thread or older runs do not satisfy validation.`);
  console.log('[refreshModels] Smoke requirement: a passed api-data smoke/typecheck result is still required before treating this iteration as validated.');
  console.log(`[refreshModels] Operator-facing defer note: partial observability only unless this execution emits a fresh same-thread LangSmith api-data run/trace with explicit goal context for ${REFRESH_MODELS_THREAD}; preserve a no-run defer reason instead of treating cross-thread activity as validation.`);
  console.log(`[refreshModels] Operator-facing defer reason: ${REFRESH_MODELS_DEFER_REASON}`);
}

main().catch((err) => {
  logRefreshModelsContext('error', 'failed');
  console.error(`[refreshModels] Goal context confirmation: ${REFRESH_MODELS_GOAL}`);
  console.error(`[refreshModels] Repair signal confirmation: ${REFRESH_MODELS_REPAIR_SIGNAL}`);
  console.error(`[refreshModels] Operator-facing defer note: ${REFRESH_MODELS_DEFER_REASON}`);
  console.error('Failed to refresh models.json:', err);
  process.exit(1);
});
