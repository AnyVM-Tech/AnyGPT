import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export const AutonomousEditActionSchema = z.object({
  type: z.enum(['replace', 'write']),
  path: z.string(),
  reason: z.string().default(''),
  find: z.string().optional(),
  replace: z.string().optional(),
  content: z.string().optional(),
});

export const AutonomousEditPlanSchema = z.object({
  summary: z.string().default(''),
  edits: z.array(AutonomousEditActionSchema).default([]),
});

export const AppliedAutonomousEditSchema = AutonomousEditActionSchema.extend({
  status: z.enum(['applied', 'skipped', 'failed']),
  message: z.string().default(''),
});

export const AutonomousEditTouchedFileSchema = z.object({
  path: z.string(),
  existedBefore: z.boolean().default(false),
  beforeContent: z.string().default(''),
});

export const AutonomousEditSessionManifestSchema = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  requestedActions: z.array(AutonomousEditActionSchema).default([]),
  appliedEdits: z.array(AppliedAutonomousEditSchema).default([]),
  touchedFiles: z.array(AutonomousEditTouchedFileSchema).default([]),
  rollbackStatus: z.enum(['not-required', 'pending', 'applied', 'failed']).default('not-required'),
  rollbackNotes: z.array(z.string()).default([]),
});

export type AutonomousEditAction = z.infer<typeof AutonomousEditActionSchema>;
export type AutonomousEditPlan = z.infer<typeof AutonomousEditPlanSchema>;
export type AppliedAutonomousEdit = z.infer<typeof AppliedAutonomousEditSchema>;
export type AutonomousEditTouchedFile = z.infer<typeof AutonomousEditTouchedFileSchema>;
export type AutonomousEditSessionManifest = z.infer<typeof AutonomousEditSessionManifestSchema>;

export type AutonomousEditRollbackResult = {
  sessionManifest: AutonomousEditSessionManifest;
  status: 'not-needed' | 'rolled-back' | 'failed';
  restoredPaths: string[];
  failedPaths: string[];
  notes: string[];
};

export type AutonomousEditContextFile = {
  path: string;
  content: string;
  truncated: boolean;
};

const DEFAULT_AUTONOMOUS_EDIT_ALLOWLIST = [
  'apps/langgraph-control-plane',
  'apps/api',
];

const DEFAULT_AUTONOMOUS_EDIT_DENYLIST = [
  '.env',
  '.env.local',
  'apps/api/.env',
  'apps/api/.env.local',
  'apps/api/keys.json',
  'node_modules',
  'dist',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'apps/langgraph-control-plane/.control-plane',
];

const LARGE_FILE_AUTONOMOUS_CONTEXT_ANCHORS: Record<string, string[]> = {
  'apps/langgraph-control-plane/src/index.ts': [
    'function parseArgs(',
    'async function runGraphOnce(',
    'async function main(',
  ],
  'apps/langgraph-control-plane/src/autonomousEdits.ts': [
    'export function readAutonomousEditContext(',
    'export function applyAutonomousEditsWithManifest(',
  ],
  'apps/langgraph-control-plane/src/langsmithClient.ts': [
    'function summarizeProject(',
    'export async function ensureLangSmithProject(',
    'export async function syncLangSmithProjectGovernance(',
  ],
  'apps/langgraph-control-plane/src/workflow.ts': [
    'function buildControlPlaneLangSmithProjectMetadata(',
    'async function callAiCodeEditAgent(',
    'async function autonomousEditPlannerNode(',
  ],
  'apps/api/providers/openai.ts': [
    'reasoning_effort',
    'buildOpenAIResponsesPayload',
    'buildOpenAIChatPayload',
  ],
  'apps/api/providers/gemini.ts': [
    'export async function',
    'function mapGemini',
  ],
  'apps/api/providers/handler.ts': [
    'export async function handleProviderRequest(',
    'function selectProvider',
  ],
  'apps/api/modules/openaiRouteUtils.ts': [
    'export function',
    'function normalize',
  ],
  'apps/api/routes/models.ts': [
    'router.get(',
    'models',
  ],
};

function normalizeRepoRelativePath(rawPath: string): string {
  return String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function splitCommaSeparatedPaths(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter(Boolean);
}

function pathMatchesPrefix(targetPath: string, prefix: string): boolean {
  return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
}

function alignExcerptStart(raw: string, start: number): number {
  if (start <= 0) return 0;
  const newlineIndex = raw.lastIndexOf('\n', start);
  return newlineIndex >= 0 ? newlineIndex + 1 : 0;
}

function alignExcerptEnd(raw: string, end: number): number {
  if (end >= raw.length) return raw.length;
  const newlineIndex = raw.indexOf('\n', end);
  return newlineIndex >= 0 ? newlineIndex : raw.length;
}

function buildHeadTailExcerpt(raw: string, maxCharsPerFile: number): string {
  const gapMarker = '\n/* [excerpt gap] */\n';
  const suffix = `\n/* [truncated original_length=${raw.length}] */`;
  const availableChars = Math.max(1200, maxCharsPerFile - gapMarker.length - suffix.length);
  const headChars = Math.floor(availableChars / 2);
  const tailChars = availableChars - headChars;

  return `${raw.slice(0, headChars)}${gapMarker}${raw.slice(Math.max(0, raw.length - tailChars))}${suffix}`;
}

function buildAnchoredExcerpt(raw: string, candidatePath: string, maxCharsPerFile: number): string {
  const anchors = LARGE_FILE_AUTONOMOUS_CONTEXT_ANCHORS[candidatePath] || [];
  if (anchors.length === 0) {
    return buildHeadTailExcerpt(raw, maxCharsPerFile);
  }

  const excerpts: string[] = [];
  const seenRanges: Array<{ start: number; end: number }> = [];
  const excerptBudget = Math.max(1200, Math.floor((maxCharsPerFile - (anchors.length * 96) - 64) / anchors.length));

  for (const anchor of anchors) {
    const anchorIndex = raw.indexOf(anchor);
    if (anchorIndex < 0) continue;

    const contextBefore = Math.max(240, Math.floor(excerptBudget * 0.2));
    const contextAfter = Math.max(960, excerptBudget - contextBefore);
    const start = alignExcerptStart(raw, Math.max(0, anchorIndex - contextBefore));
    const end = alignExcerptEnd(raw, Math.min(raw.length, anchorIndex + anchor.length + contextAfter));

    if (seenRanges.some((range) => start <= range.end && end >= range.start)) {
      continue;
    }

    seenRanges.push({ start, end });
    excerpts.push(`/* [excerpt anchor: ${anchor}] */\n${raw.slice(start, end).trimEnd()}`);
  }

  if (excerpts.length === 0) {
    return buildHeadTailExcerpt(raw, maxCharsPerFile);
  }

  return `${excerpts.join('\n\n/* [excerpt gap] */\n\n')}\n\n/* [truncated original_length=${raw.length}] */`;
}

function buildAutonomousEditContextContent(raw: string, candidatePath: string, maxCharsPerFile: number): string {
  if (raw.length <= maxCharsPerFile) return raw;
  return buildAnchoredExcerpt(raw, candidatePath, maxCharsPerFile);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const nextIndex = haystack.indexOf(needle, offset);
    if (nextIndex < 0) break;
    count += 1;
    offset = nextIndex + Math.max(1, needle.length);
  }
  return count;
}

function buildReplaceFailureDiagnostic(current: string, find: string): string {
  const trimmedFind = find.trim();
  if (!trimmedFind) {
    return 'Replace target text was not found in the file.';
  }

  const findLines = trimmedFind.split('\n').map((line) => line.trim()).filter(Boolean);
  const anchorLine = findLines.find((line) => line.length >= 12) || findLines[0] || trimmedFind.slice(0, 120);
  const currentLines = current.split('\n');
  const anchorMatchIndex = currentLines.findIndex((line) => line.includes(anchorLine));

  if (anchorMatchIndex >= 0) {
    const excerpt = currentLines
      .slice(Math.max(0, anchorMatchIndex - 2), Math.min(currentLines.length, anchorMatchIndex + 3))
      .join('\n');
    return `Replace target text was not found in the file. Closest anchor match around line ${anchorMatchIndex + 1}:\n${excerpt}`;
  }

  return `Replace target text was not found in the file. First anchor fragment: ${anchorLine.slice(0, 160)}`;
}

export function resolveAutonomousEditAllowlist(value?: string): string[] {
  const configured = splitCommaSeparatedPaths(value);
  return configured.length > 0 ? configured : [...DEFAULT_AUTONOMOUS_EDIT_ALLOWLIST];
}

export function resolveAutonomousEditDenylist(value?: string): string[] {
  const configured = splitCommaSeparatedPaths(value);
  return configured.length > 0 ? configured : [...DEFAULT_AUTONOMOUS_EDIT_DENYLIST];
}

export function checkAutonomousEditPath(
  repoRoot: string,
  candidatePath: string,
  allowlist: string[],
  denylist: string[],
): { allowed: boolean; normalizedPath: string; reason: string } {
  const normalizedCandidatePath = normalizeRepoRelativePath(candidatePath);
  if (!normalizedCandidatePath) {
    return { allowed: false, normalizedPath: normalizedCandidatePath, reason: 'Path is empty.' };
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedCandidatePath = path.resolve(resolvedRepoRoot, normalizedCandidatePath);
  const repoRelativePath = normalizeRepoRelativePath(path.relative(resolvedRepoRoot, resolvedCandidatePath));

  if (!repoRelativePath || repoRelativePath.startsWith('..') || path.isAbsolute(repoRelativePath)) {
    return { allowed: false, normalizedPath: repoRelativePath, reason: 'Path resolves outside the repository.' };
  }

  for (const denyEntry of denylist.map((entry) => normalizeRepoRelativePath(entry)).filter(Boolean)) {
    if (pathMatchesPrefix(repoRelativePath, denyEntry)) {
      return { allowed: false, normalizedPath: repoRelativePath, reason: `Path is denied by ${denyEntry}.` };
    }
  }

  const normalizedAllowlist = allowlist.map((entry) => normalizeRepoRelativePath(entry)).filter(Boolean);
  if (normalizedAllowlist.length === 0) {
    return { allowed: false, normalizedPath: repoRelativePath, reason: 'No allowlisted paths were configured.' };
  }

  if (!normalizedAllowlist.some((allowEntry) => pathMatchesPrefix(repoRelativePath, allowEntry))) {
    return { allowed: false, normalizedPath: repoRelativePath, reason: 'Path is outside the autonomous edit allowlist.' };
  }

  return { allowed: true, normalizedPath: repoRelativePath, reason: 'Allowed.' };
}

export function buildAutonomousEditCandidatePaths(scopes: string[]): string[] {
  const normalizedScopes = Array.from(new Set(scopes.map((scope) => String(scope || '').trim().toLowerCase()).filter(Boolean)));
  const candidates = new Set<string>([
    'apps/langgraph-control-plane/src/index.ts',
    'apps/langgraph-control-plane/src/autonomousEdits.ts',
    'apps/langgraph-control-plane/src/workflow.ts',
    'apps/langgraph-control-plane/README.md',
  ]);

  if (normalizedScopes.includes('repo') || normalizedScopes.includes('control-plane')) {
    candidates.add('apps/langgraph-control-plane/package.json');
  }

  if (normalizedScopes.includes('repo') || normalizedScopes.includes('api') || normalizedScopes.includes('api-experimental')) {
    candidates.add('apps/api/providers/openai.ts');
    candidates.add('apps/api/providers/gemini.ts');
    candidates.add('apps/api/providers/deepseek.ts');
    candidates.add('apps/api/providers/interfaces.ts');
    candidates.add('apps/api/providers/openrouter.ts');
    candidates.add('apps/api/providers/handler.ts');
    candidates.add('apps/api/modules/openaiProviderSelection.ts');
    candidates.add('apps/api/modules/openaiRequestSupport.ts');
    candidates.add('apps/api/modules/openaiRouteUtils.ts');
    candidates.add('apps/api/modules/openaiResponsesFormat.ts');
    candidates.add('apps/api/modules/dataManager.ts');
    candidates.add('apps/api/dev/testModelLiveProbes.ts');
    candidates.add('apps/api/routes/openai.ts');
    candidates.add('apps/api/routes/models.ts');
    candidates.add('apps/api/server.ts');
    candidates.add('apps/api/ws/wsServer.ts');
    candidates.add('apps/api/README.md');
    candidates.add('apps/api/package.json');
  }

  return Array.from(candidates);
}

export function readAutonomousEditContext(
  repoRoot: string,
  scopes: string[],
  allowlist: string[],
  denylist: string[],
  maxCharsPerFile: number = 12000,
): AutonomousEditContextFile[] {
  const files: AutonomousEditContextFile[] = [];

  for (const candidatePath of buildAutonomousEditCandidatePaths(scopes)) {
    const check = checkAutonomousEditPath(repoRoot, candidatePath, allowlist, denylist);
    if (!check.allowed) continue;

    const absolutePath = path.resolve(repoRoot, check.normalizedPath);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const raw = fs.readFileSync(absolutePath, 'utf8');
      const truncated = raw.length > maxCharsPerFile;
      files.push({
        path: check.normalizedPath,
        content: buildAutonomousEditContextContent(raw, check.normalizedPath, maxCharsPerFile),
        truncated,
      });
    } catch {
      continue;
    }
  }

  return files;
}

export function applyAutonomousEdits(
  repoRoot: string,
  actions: AutonomousEditAction[],
  allowlist: string[],
  denylist: string[],
): AppliedAutonomousEdit[] {
  return applyAutonomousEditsWithManifest(repoRoot, actions, allowlist, denylist).appliedEdits;
}

function buildAutonomousEditSessionManifest(actions: AutonomousEditAction[]): AutonomousEditSessionManifest {
  return AutonomousEditSessionManifestSchema.parse({
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    requestedActions: actions,
    rollbackStatus: 'not-required',
    rollbackNotes: [],
  });
}

function captureTouchedFileSnapshot(repoRoot: string, normalizedPath: string): AutonomousEditTouchedFile {
  const absolutePath = path.resolve(repoRoot, normalizedPath);
  const existedBefore = fs.existsSync(absolutePath);
  return AutonomousEditTouchedFileSchema.parse({
    path: normalizedPath,
    existedBefore,
    beforeContent: existedBefore ? fs.readFileSync(absolutePath, 'utf8') : '',
  });
}

export function applyAutonomousEditsWithManifest(
  repoRoot: string,
  actions: AutonomousEditAction[],
  allowlist: string[],
  denylist: string[],
): { appliedEdits: AppliedAutonomousEdit[]; sessionManifest: AutonomousEditSessionManifest } {
  const results: AppliedAutonomousEdit[] = [];
  const requestedActions = actions.map((action) => AutonomousEditActionSchema.parse(action));
  const manifest = buildAutonomousEditSessionManifest(requestedActions);
  const touchedFiles = new Map<string, AutonomousEditTouchedFile>();

  for (const action of requestedActions) {
    const check = checkAutonomousEditPath(repoRoot, action.path, allowlist, denylist);
    if (!check.allowed) {
      results.push(AppliedAutonomousEditSchema.parse({
        ...action,
        path: check.normalizedPath || normalizeRepoRelativePath(action.path),
        status: 'failed',
        message: check.reason,
      }));
      continue;
    }

    const absolutePath = path.resolve(repoRoot, check.normalizedPath);

    try {
      if (action.type === 'replace') {
        const find = typeof action.find === 'string' ? action.find : '';
        const replace = typeof action.replace === 'string' ? action.replace : '';
        if (!find) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: 'Replace action is missing a find string.',
          }));
          continue;
        }
        if (!fs.existsSync(absolutePath)) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: 'Replace target file does not exist.',
          }));
          continue;
        }

        const current = fs.readFileSync(absolutePath, 'utf8');
        const matchCount = countOccurrences(current, find);
        if (matchCount === 0) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: buildReplaceFailureDiagnostic(current, find),
          }));
          continue;
        }

        if (matchCount > 1) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: `Replace target text matched ${matchCount} times in the file; provide a more specific anchored block.`,
          }));
          continue;
        }

        const next = current.replace(find, replace);
        if (next === current) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'skipped',
            message: 'No content change was produced by the replace action.',
          }));
          continue;
        }

        if (!touchedFiles.has(check.normalizedPath)) {
          touchedFiles.set(check.normalizedPath, captureTouchedFileSnapshot(repoRoot, check.normalizedPath));
        }
        fs.writeFileSync(absolutePath, next, 'utf8');
        results.push(AppliedAutonomousEditSchema.parse({
          ...action,
          path: check.normalizedPath,
          status: 'applied',
          message: 'Replace action applied successfully.',
        }));
        continue;
      }

      const content = typeof action.content === 'string' ? action.content : '';
      if (!content) {
        results.push(AppliedAutonomousEditSchema.parse({
          ...action,
          path: check.normalizedPath,
          status: 'failed',
          message: 'Write action is missing content.',
          }));
          continue;
      }

      if (fs.existsSync(absolutePath)) {
        const current = fs.readFileSync(absolutePath, 'utf8');
        if (current === content) {
          results.push(AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'skipped',
            message: 'Write action produced no content change.',
          }));
          continue;
        }
      }

      if (!touchedFiles.has(check.normalizedPath)) {
        touchedFiles.set(check.normalizedPath, captureTouchedFileSnapshot(repoRoot, check.normalizedPath));
      }
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, 'utf8');
      results.push(AppliedAutonomousEditSchema.parse({
        ...action,
        path: check.normalizedPath,
        status: 'applied',
        message: 'Write action applied successfully.',
      }));
    } catch (error: any) {
      results.push(AppliedAutonomousEditSchema.parse({
        ...action,
        path: check.normalizedPath,
        status: 'failed',
        message: error?.message || String(error),
      }));
    }
  }

  return {
    appliedEdits: results,
    sessionManifest: AutonomousEditSessionManifestSchema.parse({
      ...manifest,
      appliedEdits: results,
      touchedFiles: Array.from(touchedFiles.values()),
      rollbackStatus: touchedFiles.size > 0 ? 'pending' : 'not-required',
    }),
  };
}

export function rollbackAutonomousEditSession(
  repoRoot: string,
  manifestInput: AutonomousEditSessionManifest,
  allowlist: string[],
  denylist: string[],
): AutonomousEditRollbackResult {
  const manifest = AutonomousEditSessionManifestSchema.parse(manifestInput);
  if (manifest.touchedFiles.length === 0) {
    const notes = ['No touched files were recorded, so rollback was not required.'];
    return {
      sessionManifest: AutonomousEditSessionManifestSchema.parse({
        ...manifest,
        rollbackStatus: 'not-required',
        rollbackNotes: [...manifest.rollbackNotes, ...notes],
      }),
      status: 'not-needed',
      restoredPaths: [],
      failedPaths: [],
      notes,
    };
  }

  const restoredPaths: string[] = [];
  const failedPaths: string[] = [];
  const notes: string[] = [];

  for (const touchedFile of [...manifest.touchedFiles].reverse()) {
    const check = checkAutonomousEditPath(repoRoot, touchedFile.path, allowlist, denylist);
    if (!check.allowed) {
      failedPaths.push(touchedFile.path);
      notes.push(`Rollback failed for ${touchedFile.path}: ${check.reason}`);
      continue;
    }

    const absolutePath = path.resolve(repoRoot, check.normalizedPath);
    try {
      if (touchedFile.existedBefore) {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, touchedFile.beforeContent, 'utf8');
        restoredPaths.push(check.normalizedPath);
        notes.push(`Rollback restored ${check.normalizedPath}.`);
        continue;
      }

      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
      restoredPaths.push(check.normalizedPath);
      notes.push(`Rollback removed ${check.normalizedPath}.`);
    } catch (error: any) {
      failedPaths.push(check.normalizedPath);
      notes.push(`Rollback failed for ${check.normalizedPath}: ${error?.message || String(error)}`);
    }
  }

  const status: AutonomousEditRollbackResult['status'] = failedPaths.length > 0 ? 'failed' : 'rolled-back';
  return {
    sessionManifest: AutonomousEditSessionManifestSchema.parse({
      ...manifest,
      rollbackStatus: status === 'failed' ? 'failed' : 'applied',
      rollbackNotes: [...manifest.rollbackNotes, ...notes],
    }),
    status,
    restoredPaths,
    failedPaths,
    notes,
  };
}
