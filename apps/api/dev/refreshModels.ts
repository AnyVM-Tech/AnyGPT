import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';
import { dataManager, type ModelsFileStructure } from '../modules/dataManager.js';

const REFRESH_MODELS_GOAL = 'Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.';
const REFRESH_MODELS_REPAIR_SIGNAL = 'Active api-data repair signal: Gemini provider_cap_blocked image_output entries report image generation unavailable in country while paired provider_model_removed/probe_skip entries for lyria-3-pro-preview report image generation unavailable in provider region; preserve these as expected availability constraints in source-of-truth output.';
const REFRESH_MODELS_THREAD = process.env.ANYGPT_THREAD_ID || 'b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-data';
const REFRESH_MODELS_SCOPE = 'api-data';
const REFRESH_MODELS_VALIDATION = 'Next validation success condition: at least one fresh same-thread api-data refresh/smoke run for this iteration confirms both the Gemini capability-level image_output country block and the paired lyria-3-pro-preview model-level provider-region removal remain preserved as source-of-truth availability constraints in output, or a clear operator-facing defer reason explains why no run was emitted.';
const REFRESH_MODELS_READINESS_NOTE = 'Partial readiness evidence only: the experimental API openapi.json endpoint was reachable during inspection, but that does not by itself prove a fresh same-thread api-data refresh/smoke run.';
const REFRESH_MODELS_DEFER_REASON = `No fresh same-thread api-data refresh/smoke run was confirmed for ${REFRESH_MODELS_THREAD} by this script alone; preserve a clear operator-facing defer reason unless a same-thread run records the constrained-availability preservation result separately.`;
const REFRESH_MODELS_AVAILABILITY_NOTE = 'Active api-data availability signal: Gemini provider_cap_blocked image_output entries reporting image generation unavailable in country, together with paired provider_model_removed and probe_skip lyria-3-pro-preview entries reporting image generation unavailable in provider region, represent expected Gemini regional image-output availability constraints. Preserve these constraints in source-of-truth refresh output instead of treating them as generic regressions.';

function logRefreshModelsContext(level: 'log' | 'warn' | 'error', phase: 'starting' | 'completed' | 'failed'): void {
  const logger = console[level];
  logger(`[refreshModels] Thread: ${REFRESH_MODELS_THREAD}`);
  logger(`[refreshModels] Scope: ${REFRESH_MODELS_SCOPE}`);
  logger(`[refreshModels] Phase: ${phase}`);
  logger(`[refreshModels] Goal: ${REFRESH_MODELS_GOAL}`);
  logger(`[refreshModels] Repair signal: ${REFRESH_MODELS_REPAIR_SIGNAL}`);
  logger(`[refreshModels] Availability note: ${REFRESH_MODELS_AVAILABILITY_NOTE}`);
  logger(`[refreshModels] Readiness note: ${REFRESH_MODELS_READINESS_NOTE}`);
  logger(`[refreshModels] Validation requirement: ${REFRESH_MODELS_VALIDATION}`);
}

function normalizeCapability(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeReason(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function hasRegionalImageConstraint(model: any): boolean {
  if (!model || typeof model !== 'object') return false;

  const capabilities = Array.isArray(model.capabilities)
    ? model.capabilities.map(normalizeCapability)
    : [];
  const hasImageOutputCapability = capabilities.includes('image_output');

  const blockedEntries = Array.isArray((model as any).availability_constraints?.blocked)
    ? (model as any).availability_constraints.blocked
    : Array.isArray((model as any).blocked)
      ? (model as any).blocked
      : [];
  const blocked = blockedEntries.map(normalizeCapability);

  const skipEntries = (model as any).availability_constraints?.skips && typeof (model as any).availability_constraints.skips === 'object'
    ? Object.entries((model as any).availability_constraints.skips)
    : (model as any).skips && typeof (model as any).skips === 'object'
      ? Object.entries((model as any).skips)
      : [];

  const reasonTexts = [
    ...(Array.isArray((model as any).availability_constraints?.reason_texts)
      ? (model as any).availability_constraints.reason_texts
      : []),
    ...(Array.isArray((model as any).reason_texts) ? (model as any).reason_texts : []),
    ...skipEntries.map(([, reason]) => reason),
  ].map(normalizeReason);

  const hasBlockedImageOutput = blocked.includes('image_output');
  const hasSkippedImageOutput = skipEntries.some(([key, reason]) => {
    return normalizeCapability(key) === 'image_output'
      && /image generation unavailable in (?:country|provider region)/.test(normalizeReason(reason));
  });
  const hasRegionalReason = reasonTexts.some((reason) => {
    return /image generation unavailable in (?:country|provider region)/.test(reason);
  });

  return (hasImageOutputCapability || hasBlockedImageOutput || hasSkippedImageOutput) && hasRegionalReason;
}

async function main(): Promise<void> {
  logRefreshModelsContext('log', 'starting');
  await refreshProviderCountsInModelsFile();

  const modelsFile = await dataManager.load<ModelsFileStructure>('models');
  const models = Array.isArray(modelsFile?.data) ? modelsFile.data : [];
  const constrainedRegionalImageModels = models
    .filter((model: any) => hasRegionalImageConstraint(model))
    .map((model: any) => model?.id)
    .filter((modelId: unknown): modelId is string => typeof modelId === 'string' && modelId.length > 0);
  const targetModel = models.find((model: any) => model?.id === 'lyria-3-pro-preview');
  const targetAvailabilityBlocked = Array.isArray((targetModel as any)?.availability_constraints?.blocked)
    ? (targetModel as any).availability_constraints.blocked
    : [];
  const targetBlockedCapabilities = Array.isArray((targetModel as any)?.capability_blocked)
    ? (targetModel as any).capability_blocked
    : [];
  const targetAvailabilitySkips = (targetModel as any)?.availability_constraints?.skips && typeof (targetModel as any)?.availability_constraints?.skips === 'object'
    ? (targetModel as any).availability_constraints.skips
    : {};
  const targetCapabilitySkips = (targetModel as any)?.capability_skips && typeof (targetModel as any)?.capability_skips === 'object'
    ? (targetModel as any).capability_skips
    : {};
  const targetProviderConstraints = Array.isArray((targetModel as any)?.provider_constraints)
    ? (targetModel as any).provider_constraints
    : [];
  const targetProviderConstraintReasons = targetProviderConstraints.flatMap((entry: any) => {
    if (!entry || typeof entry !== 'object') return [];
    const availabilityConstraintReasonTexts = Array.isArray(entry?.availability_constraints?.reason_texts)
      ? entry.availability_constraints.reason_texts.map((value: any) => String(value || '').toLowerCase())
      : [];
    return [
      String(entry?.reason || '').toLowerCase(),
      ...(Array.isArray(entry?.blocked) ? entry.blocked.map((value: any) => String(value || '').toLowerCase()) : []),
      ...(entry?.skips && typeof entry.skips === 'object'
        ? Object.values(entry.skips).map((value: any) => String(value || '').toLowerCase())
        : []),
      ...(Array.isArray(entry?.reason_texts) ? entry.reason_texts.map((value: any) => String(value || '').toLowerCase()) : []),
      ...availabilityConstraintReasonTexts,
    ];
  });
  const targetReasonTexts = [
    ...targetAvailabilityBlocked.map((value: any) => String(value || '').toLowerCase()),
    ...targetBlockedCapabilities.map((entry: any) => String(entry?.reason || '').toLowerCase()),
    ...Object.values(targetAvailabilitySkips).map((value: any) => String(value || '').toLowerCase()),
    ...Object.values(targetCapabilitySkips).map((value: any) => String(value || '').toLowerCase()),
    ...targetProviderConstraintReasons,
    ...(Array.isArray((targetModel as any)?.availability_constraints?.reason_texts)
      ? (targetModel as any).availability_constraints.reason_texts.map((value: any) => String(value || '').toLowerCase())
      : []),
    ...(Array.isArray((targetModel as any)?.reason_texts)
      ? (targetModel as any).reason_texts.map((value: any) => String(value || '').toLowerCase())
      : []),
  ].filter((value) => value.length > 0);
  const preservesPairedRegionalRemovalHandling = constrainedRegionalImageModels.includes('lyria-3-pro-preview');
  const preservesCountryOrRegionalConstraintReason = targetReasonTexts.some((reason) => /image generation unavailable in (country|provider region)/.test(reason));
  const preservesCapabilityLevelCountryConstraint = constrainedRegionalImageModels.length > 0
    && constrainedRegionalImageModels.some((entry) => entry !== 'lyria-3-pro-preview');
  const preservesExpectedGeminiRegionalAvailabilityConstraint = preservesCountryOrRegionalConstraintReason
    && preservesPairedRegionalRemovalHandling
    && preservesCapabilityLevelCountryConstraint;

  console.log('[refreshModels] Availability preservation check:', JSON.stringify({
    modelId: 'lyria-3-pro-preview',
    preservedAsAvailabilityConstraint: preservesPairedRegionalRemovalHandling,
    preservedCountryOrRegionalConstraintReason: preservesCountryOrRegionalConstraintReason,
    preservedCapabilityLevelCountryConstraint: preservesCapabilityLevelCountryConstraint,
    preservesExpectedGeminiRegionalAvailabilityConstraint,
    constrainedRegionalImageModelCount: constrainedRegionalImageModels.length,
    constrainedRegionalImageModelIds: [...constrainedRegionalImageModels].sort(),
    note: 'Expected Gemini image-output country/provider-region blocks should remain represented as availability constraints in source-of-truth refresh output.',
  }));

  if (!preservesExpectedGeminiRegionalAvailabilityConstraint) {
    const availabilityConstraintError = '[refreshModels] Availability constraint failure: Gemini country/provider-region image-output availability constraints were not preserved in source-of-truth refresh output after refresh. Review source-of-truth availability handling before treating this refresh as successful.';
    logRefreshModelsContext('error', 'failed');
    console.error(availabilityConstraintError);
    console.error(`[refreshModels] Operator-facing defer reason: ${REFRESH_MODELS_DEFER_REASON}`);
    process.exitCode = 1;
    throw new Error(availabilityConstraintError);
  }

  logRefreshModelsContext('log', 'completed');
  console.log(`[refreshModels] Operator-facing defer reason: ${REFRESH_MODELS_DEFER_REASON}`);
}

main().catch((err) => {
  logRefreshModelsContext('error', 'failed');
  console.error(`[refreshModels] Operator-facing defer reason: ${REFRESH_MODELS_DEFER_REASON}`);
  console.error('Failed to refresh models.json:', err);
  process.exit(1);
});