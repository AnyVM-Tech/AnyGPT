type AutonomousSkillContractTemplate = {
  summary: string;
  checks: string[];
  preferredPaths: string[];
};

type AutonomousSkillDefinition = {
  id: string;
  title: string;
  scopes: string[];
  alwaysLoad?: boolean;
  description: string;
  guidance: string[];
  references: string[];
  signalPatterns?: string[];
  contract?: AutonomousSkillContractTemplate;
};

export type ResolvedAutonomousSkill = {
  id: string;
  title: string;
  description: string;
  guidance: string[];
  references: string[];
  contract?: AutonomousSkillContractTemplate;
  score: number;
};

const AUTONOMOUS_SKILL_SCOPE_PRIORITY = [
  'api-routing',
  'api-runtime',
  'api-data',
  'api-platform',
  'control-plane',
  'ui-surface',
  'homepage-surface',
  'workspace-surface',
  'repo-surface',
  'api',
  'api-experimental',
  'repo',
] as const;

const AUTONOMOUS_SKILLS: AutonomousSkillDefinition[] = [
  {
    id: 'autonomous-edit-guardrails',
    title: 'Autonomous Edit Guardrails',
    scopes: ['repo', 'api', 'api-experimental', 'api-routing', 'api-runtime', 'api-data', 'api-platform', 'control-plane', 'repo-surface', 'workspace-surface', 'homepage-surface', 'ui-surface'],
    alwaysLoad: true,
    description: 'Generated artifacts, logs, runtime state, and sensitive key material are read-only. Prefer bounded source-file edits with deterministic validation.',
    guidance: [
      'Treat .control-plane state, dist outputs, logs, node_modules, and key files as read-only surfaces.',
      'Prefer one bounded source-file edit with explicit validation over broad rewrites or generated-file churn.',
      'When deterministic validators fail after an edit, treat their output as binding feedback for the next retry instead of reusing the same edit shape.',
    ],
    references: [
      'apps/langgraph-control-plane/src/autonomousEdits.ts',
      'apps/langgraph-control-plane/src/index.ts',
      'apps/langgraph-control-plane/src/workflow.ts',
    ],
  },
  {
    id: 'api-routing-resilience',
    title: 'API Routing Resilience',
    scopes: ['api-routing'],
    description: 'Routing work should focus on provider eligibility, capability gating, skip reasons, and retry-worthlessness in the hot path.',
    guidance: [
      'Prefer routing-time compatibility filters, provider de-prioritization, or skip-reason clarity over broad provider rewrites.',
      'Differentiate persistent-ish failures in the current window (401, insufficient_quota, capability block, regional block) from transient failures such as timeouts.',
      'Bias toward handler.ts and route-support hot paths first; use geminiMediaValidation.ts or openaiProviderSelection.ts only when the active signal family clearly matches.',
    ],
    references: [
      'apps/api/providers/handler.ts',
      'apps/api/modules/geminiMediaValidation.ts',
      'apps/api/modules/openaiRouteSupport.ts',
      'apps/api/modules/openaiRouteUtils.ts',
      'apps/api/modules/openaiProviderSelection.ts',
      'apps/api/routes/openai.ts',
    ],
    signalPatterns: [
      'provider_cap_blocked',
      'provider_model_removed',
      'rate limit',
      'insufficient_quota',
      'audio/s16le',
      'function calling is not enabled',
      'retry-worthless',
      'tool_calling',
      'timeout',
    ],
    contract: {
      summary: 'Routing contract: make one bounded provider-selection, capability-gating, or retry-worthlessness improvement that prevents unsupported or exhausted candidates from being attempted again.',
      checks: [
        'Prefer routing-time compatibility filters, skip reasons, or candidate de-prioritization over broad provider rewrites.',
        'Provider-file edits are only valid here when they are small api-routing compatibility or selection guards tied directly to the active signals.',
      ],
      preferredPaths: [
        'apps/api/providers/handler.ts',
        'apps/api/providers/gemini.ts',
        'apps/api/providers/openrouter.ts',
        'apps/api/modules/openaiProviderSelection.ts',
        'apps/api/modules/openaiRouteSupport.ts',
        'apps/api/modules/openaiRouteUtils.ts',
        'apps/api/modules/openaiResponsesFormat.ts',
        'apps/api/modules/geminiMediaValidation.ts',
        'apps/api/routes/openai.ts',
      ],
    },
  },
  {
    id: 'api-runtime-classification',
    title: 'API Runtime Classification',
    scopes: ['api-runtime'],
    description: 'Runtime work should make repetitive provider churn easier to classify and handle without widening into model-sync or catalog changes.',
    guidance: [
      'Prefer requestQueue, requestIntake, errorClassification, errorLogger, or middlewareFactory over provider/model source-of-truth files.',
      'Turn repetitive external/provider churn into clearer failure origin, load-shedding, or retry behavior rather than speculative provider fixes.',
      'Queue or memory-pressure changes should be narrow and observability-driven before concurrency widening.',
    ],
    references: [
      'apps/api/modules/errorClassification.ts',
      'apps/api/modules/requestQueue.ts',
      'apps/api/modules/requestIntake.ts',
      'apps/api/modules/errorLogger.ts',
      'apps/api/modules/middlewareFactory.ts',
      'apps/api/modules/rateLimit.ts',
      'apps/api/modules/rateLimitRedis.ts',
    ],
    signalPatterns: [
      'memory pressure',
      'queue',
      'overloaded',
      'failureOrigin',
      'request-queue',
      'retry',
    ],
    contract: {
      summary: 'Runtime classification contract: make one bounded queue, intake, or failure-classification improvement that turns repetitive external/provider churn into clearer local handling.',
      checks: [
        'Prefer requestQueue, requestIntake, errorClassification, errorLogger, or middlewareFactory paths over source-of-truth model/provider files.',
        'Success means the change reduces ambiguous retries or clarifies provider-bound failures without widening into catalog-sync edits.',
      ],
      preferredPaths: [
        'apps/api/modules/errorClassification.ts',
        'apps/api/modules/requestQueue.ts',
        'apps/api/modules/requestIntake.ts',
        'apps/api/modules/errorLogger.ts',
        'apps/api/modules/middlewareFactory.ts',
        'apps/api/modules/rateLimit.ts',
        'apps/api/modules/rateLimitRedis.ts',
      ],
    },
  },
  {
    id: 'api-data-source-of-truth',
    title: 'API Data Source of Truth',
    scopes: ['api-data'],
    description: 'Data-sync work should prefer source-of-truth model/provider/pricing files and avoid audit-only helpers unless the signal explicitly points there.',
    guidance: [
      'Use models.json, pricing.json, updateproviders.ts, updatemodels.ts, modelUpdater.ts, and routes/models.ts as the primary repair surface.',
      'Do not respond to plain auth/quota drift by churning source-of-truth catalog files.',
      'Prefer explicit availability constraints and catalog drift handling over speculative capability-helper edits.',
    ],
    references: [
      'apps/api/models.json',
      'apps/api/pricing.json',
      'apps/api/modules/modelUpdater.ts',
      'apps/api/dev/updateproviders.ts',
      'apps/api/dev/updatemodels.ts',
      'apps/api/routes/models.ts',
    ],
    signalPatterns: [
      'pricing',
      'provider count',
      'availability',
      'catalog drift',
      'models.json',
      'pricing.json',
    ],
    contract: {
      summary: 'Data source-of-truth contract: make one bounded source-of-truth model/provider/pricing change and avoid audit-only helper churn unless the active signal explicitly points to it.',
      checks: [
        'Prefer models.json, pricing.json, modelUpdater.ts, updateproviders.ts, updatemodels.ts, and routes/models.ts over audit helpers.',
        'Success means a concrete source-of-truth availability or pricing delta is addressed without widening into unrelated runtime/provider edits.',
      ],
      preferredPaths: [
        'apps/api/models.json',
        'apps/api/pricing.json',
        'apps/api/modules/modelUpdater.ts',
        'apps/api/dev/updateproviders.ts',
        'apps/api/dev/updatemodels.ts',
        'apps/api/routes/models.ts',
      ],
    },
  },
  {
    id: 'api-platform-health',
    title: 'API Platform Health',
    scopes: ['api-platform'],
    description: 'Platform work should stay on experimental service health, startup wiring, websocket behavior, and service-unit validation.',
    guidance: [
      'Prefer server.ts, server.launcher.bun.ts, wsServer.ts, and experimental service-unit paths.',
      'Keep platform fixes experimental-safe and avoid production restarts or provider-selection churn.',
      'Success is startup, service, or websocket health improvement with bounded validation.',
    ],
    references: [
      'apps/api/server.ts',
      'apps/api/server.launcher.bun.ts',
      'apps/api/ws/wsServer.ts',
      'apps/api/anygpt-api.service',
      'apps/api/anygpt-experimental.service',
    ],
    contract: {
      summary: 'Platform health contract: make one bounded experimental API entrypoint, service, websocket, or startup-health improvement with safe validation.',
      checks: [
        'Prefer server, launcher, websocket, or service-unit paths and avoid source-of-truth provider/model edits in this lane.',
        'Success means the change improves experimental runtime health or observability without requiring production restarts.',
      ],
      preferredPaths: [
        'apps/api/server.ts',
        'apps/api/server.launcher.bun.ts',
        'apps/api/ws/wsServer.ts',
        'apps/api/anygpt-api.service',
        'apps/api/anygpt-experimental.service',
      ],
    },
  },
  {
    id: 'control-plane-recovery',
    title: 'Control-Plane Recovery',
    scopes: ['control-plane'],
    description: 'Control-plane work should focus on orchestration, observability, prompt/workflow hardening, and autonomous recovery heuristics.',
    guidance: [
      'Prefer workflow.ts, index.ts, autonomousEdits.ts, and README.md for bounded orchestration or observability improvements.',
      'Treat upstream/provider failures outside scope as observability inputs, not proof of a control-plane regression.',
      'Success means the change stays inside control-plane scope and improves recovery, clarity, or workflow safety.',
    ],
    references: [
      'apps/langgraph-control-plane/src/workflow.ts',
      'apps/langgraph-control-plane/src/index.ts',
      'apps/langgraph-control-plane/src/autonomousEdits.ts',
      'apps/langgraph-control-plane/README.md',
    ],
    signalPatterns: [
      'langsmith',
      'self-heal',
      'orchestration',
      'workflow',
      'observability',
      'no-run defer',
    ],
    contract: {
      summary: 'Control-plane contract: make one orchestration, observability, or workflow-hardening change with passing control-plane validation.',
      checks: [
        'Success means the change stays inside control-plane scope and passes control-plane smoke validation.',
        'Prefer clearer recovery, status, prompt, or workflow safety behavior over speculative app-surface fixes.',
      ],
      preferredPaths: [
        'apps/langgraph-control-plane/src/workflow.ts',
        'apps/langgraph-control-plane/src/index.ts',
        'apps/langgraph-control-plane/src/autonomousEdits.ts',
        'apps/langgraph-control-plane/README.md',
      ],
    },
  },
  {
    id: 'research-scout-ideas',
    title: 'Research Scout Ideas',
    scopes: ['research-scout'],
    description: 'Research scout searches the web for practical architecture ideas, maps them to in-scope paths, and publishes suggestions without writing code.',
    guidance: [
      'Search for implementation patterns, not vague inspiration, and summarize only ideas that can be mapped to in-scope files.',
      'Prefer suggestion notes and semantic-memory updates over code edits in the research scout lane.',
      'Rate practicality based on contract-path fit, loaded-skill references, and whether the codebase already has a nearby insertion point.',
    ],
    references: [
      'apps/langgraph-control-plane/src/workflow.ts',
      'apps/langgraph-control-plane/src/autonomousEdits.ts',
      'apps/langgraph-control-plane/src/index.ts',
      'apps/api/providers/handler.ts',
      'apps/api/modules/errorClassification.ts',
    ],
    contract: {
      summary: 'Research scout contract: search the web for practical implementation ideas, map them to in-scope files, and publish bounded suggestions without proposing code edits in this lane.',
      checks: [
        'Prefer suggestion notes, semantic-memory updates, and path-mapped implementation ideas over code changes.',
        'Every suggestion must name likely target files or subsystems and explain whether implementation looks high, medium, or low practicality.',
      ],
      preferredPaths: [
        'apps/langgraph-control-plane/src/workflow.ts',
        'apps/langgraph-control-plane/src/autonomousEdits.ts',
        'apps/langgraph-control-plane/src/index.ts',
        'apps/api/providers/handler.ts',
        'apps/api/modules/errorClassification.ts',
      ],
    },
  },
  {
    id: 'ui-surface-shell',
    title: 'UI Surface Shell',
    scopes: ['ui-surface'],
    description: 'UI-surface work should focus on shell, static assets, startup scripts, and browser-visible payoff.',
    guidance: [
      'Prefer favicon, static-asset, shell, and startup-script fixes over backend changes.',
      'Validate by browser-visible payoff: page load, asset success, and console/network cleanliness.',
      'Keep UI fixes path-bounded and reversible.',
    ],
    references: [
      'apps/ui/librechat/client/index.html',
      'apps/ui/librechat/client/src/App.jsx',
      'apps/ui/librechat/client/src/main.jsx',
      'apps/ui/librechat/client/src/style.css',
      'apps/ui/scripts/dev.sh',
      'apps/ui/scripts/start.sh',
      'apps/ui/scripts/sync-config.sh',
    ],
    contract: {
      summary: 'UI shell contract: make one bounded UI shell or static-asset improvement with a direct browser-visible payoff.',
      checks: [
        'Prefer frontend shell, favicon/static asset, or asset-origin fixes in apps/ui over backend changes.',
        'Success means one direct browser-visible payoff with bounded validation.',
      ],
      preferredPaths: [
        'apps/ui/librechat/client/index.html',
        'apps/ui/librechat/client/src/App.jsx',
        'apps/ui/librechat/client/src/main.jsx',
        'apps/ui/librechat/client/src/style.css',
        'apps/ui/scripts/dev.sh',
        'apps/ui/scripts/start.sh',
        'apps/ui/scripts/sync-config.sh',
      ],
    },
  },
  {
    id: 'homepage-surface-static',
    title: 'Homepage Surface Static',
    scopes: ['homepage-surface'],
    description: 'Homepage work should stay on public static assets and page-visible polish.',
    guidance: [
      'Prefer homepage public assets, serve.js, and page shell fixes over app/runtime work.',
      'Keep the payoff directly visible in the homepage browser surface.',
    ],
    references: [
      'apps/homepage/public/index.html',
      'apps/homepage/public/script.js',
      'apps/homepage/public/style.css',
      'apps/homepage/serve.js',
    ],
    contract: {
      summary: 'Homepage surface contract: make one bounded static-asset or browser-shell improvement with a direct homepage-visible payoff.',
      checks: [
        'Prefer favicon or static-asset fixes in homepage public files over speculative backend changes.',
        'Success means a direct homepage-visible payoff with bounded validation.',
      ],
      preferredPaths: [
        'apps/homepage/public/index.html',
        'apps/homepage/public/script.js',
        'apps/homepage/public/style.css',
        'apps/homepage/serve.js',
      ],
    },
  },
  {
    id: 'workspace-surface-operator',
    title: 'Workspace Surface Operator',
    scopes: ['workspace-surface', 'repo-surface'],
    description: 'Workspace-surface work should focus on root scripts, config, and operator-facing developer workflow improvements.',
    guidance: [
      'Prefer package.json, workspace config, root scripts, and setup docs over app-surface churn.',
      'Success is a bounded operator-visible or developer-workflow payoff, not speculative runtime work.',
    ],
    references: [
      'package.json',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'scripts/run-frontend-stack.sh',
      'scripts/with-bun-path.sh',
      'SETUP.md',
    ],
    contract: {
      summary: 'Workspace surface contract: make one bounded root-workspace or developer-workflow improvement with direct operator payoff.',
      checks: [
        'Prefer root scripts, workspace config, or setup/docs changes over speculative app-surface edits.',
        'Success means a direct operator or developer workflow improvement with bounded validation.',
      ],
      preferredPaths: [
        'package.json',
        'pnpm-workspace.yaml',
        'tsconfig.json',
        'scripts/run-frontend-stack.sh',
        'scripts/with-bun-path.sh',
        'SETUP.md',
      ],
    },
  },
];

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(new Set(
    scopes
      .map((scope) => String(scope || '').trim().toLowerCase())
      .filter(Boolean),
  ));
}

function buildAutonomousSkillSourceText(options: {
  goal?: string;
  repairSignals?: string[];
  improvementSignals?: string[];
}): string {
  return [
    options.goal || '',
    ...(options.repairSignals || []),
    ...(options.improvementSignals || []),
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

function resolvePrimaryAutonomousScope(effectiveScopes: string[]): string {
  const normalizedScopes = normalizeScopes(effectiveScopes);
  return AUTONOMOUS_SKILL_SCOPE_PRIORITY.find((scope) => normalizedScopes.includes(scope)) || normalizedScopes[0] || '';
}

function scoreAutonomousSkill(
  skill: AutonomousSkillDefinition,
  options: {
    effectiveScopes: string[];
    primaryScope: string;
    sourceText: string;
    autonomousContractPaths?: string[];
  },
): number {
  let score = skill.alwaysLoad ? 100 : 0;
  const normalizedScopes = normalizeScopes(options.effectiveScopes);
  const normalizedPrimaryScope = String(options.primaryScope || '').trim().toLowerCase();
  const contractPaths = Array.from(new Set(
    (options.autonomousContractPaths || [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  ));

  if (skill.scopes.some((scope) => normalizedScopes.includes(scope))) {
    score += 5;
  }
  if (normalizedPrimaryScope && skill.scopes.includes(normalizedPrimaryScope)) {
    score += 4;
  }
  if ((skill.signalPatterns || []).some((pattern) => options.sourceText.includes(pattern.toLowerCase()))) {
    score += 3;
  }
  if (contractPaths.some((candidatePath) => skill.references.includes(candidatePath) || skill.contract?.preferredPaths.includes(candidatePath))) {
    score += 2;
  }
  return score;
}

export function resolveAutonomousSkillBundle(options: {
  effectiveScopes: string[];
  goal?: string;
  repairSignals?: string[];
  improvementSignals?: string[];
  autonomousContractPaths?: string[];
  maxLoaded?: number;
}): { alwaysLoaded: ResolvedAutonomousSkill[]; loaded: ResolvedAutonomousSkill[] } {
  const sourceText = buildAutonomousSkillSourceText(options);
  const primaryScope = resolvePrimaryAutonomousScope(options.effectiveScopes);
  const maxLoaded = Math.max(1, Math.min(4, Math.floor(options.maxLoaded ?? 3)));

  const scored = AUTONOMOUS_SKILLS
    .map((skill) => ({
      skill,
      score: scoreAutonomousSkill(skill, {
        effectiveScopes: options.effectiveScopes,
        primaryScope,
        sourceText,
        autonomousContractPaths: options.autonomousContractPaths,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id));

  const alwaysLoaded = scored
    .filter((entry) => entry.skill.alwaysLoad)
    .map(({ skill, score }) => ({
      id: skill.id,
      title: skill.title,
      description: skill.description,
      guidance: skill.guidance,
      references: skill.references,
      contract: skill.contract,
      score,
    }));

  const loaded = scored
    .filter((entry) => !entry.skill.alwaysLoad)
    .slice(0, maxLoaded)
    .map(({ skill, score }) => ({
      id: skill.id,
      title: skill.title,
      description: skill.description,
      guidance: skill.guidance,
      references: skill.references,
      contract: skill.contract,
      score,
    }));

  return { alwaysLoaded, loaded };
}

export function resolveScopedAutonomousContractTemplate(options: {
  effectiveScopes: string[];
  goal?: string;
  repairSignals?: string[];
  improvementSignals?: string[];
  autonomousContractPaths?: string[];
}): AutonomousSkillContractTemplate | null {
  const bundle = resolveAutonomousSkillBundle({
    ...options,
    maxLoaded: 4,
  });
  const bestSkillWithContract = [...bundle.loaded, ...bundle.alwaysLoaded]
    .find((skill) => skill.contract);
  return bestSkillWithContract?.contract || null;
}
