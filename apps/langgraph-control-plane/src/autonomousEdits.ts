import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
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
  rawCharCount: number;
  selectionReason: string;
  excerptStrategy: 'full' | 'anchored' | 'head-tail';
  anchorHints: string[];
};

export type ReadAutonomousEditContextOptions = {
  maxCharsPerFile?: number;
  preferredAnchorsByPath?: Record<string, string[]>;
  preferredPaths?: string[];
  maxFiles?: number;
};

const DEFAULT_AUTONOMOUS_EDIT_ALLOWLIST = ['*'];

const DEFAULT_AUTONOMOUS_EDIT_DENYLIST: string[] = [
  '.git',
  '.codeql',
  'logs',
  'dist',
  'node_modules',
  'apps/api/.control-plane',
  'apps/api/dist',
  'apps/api/logs',
  'apps/api/node_modules',
  'apps/api/keys.json',
  'apps/langgraph-control-plane/.control-plane',
  'apps/langgraph-control-plane/dist',
  'apps/langgraph-control-plane/node_modules',
  'apps/homepage/node_modules',
];

const AUTONOMOUS_EDIT_CONTEXT_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.zip',
  '.pdf',
]);

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
    'const DEFAULT_CONTROL_PLANE_AUTONOMOUS_EDIT_PROMPT = [',
    'const DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE = ControlPlanePromptBundleSchema.parse({',
    'function buildControlPlaneLangSmithProjectMetadata(',
    'function buildProviderSyncChurnNotes(',
    'function appendUniqueNotes(',
    'async function callAiCodeEditAgent(',
    'async function autonomousEditPlannerNode(',
  ],
  'apps/langgraph-control-plane/src/studioGraph.ts': [
    'const repoRoot = path.resolve(',
    'const graph = await createPersistentStudioControlPlaneGraph({',
    'export { graph };',
  ],
  'apps/langgraph-control-plane/langgraph.json': [
    '"graphs": {',
    '"control-plane": "./dist/studioGraph.js:graph"',
    '"env": "../../.env.local"',
  ],
  'apps/api/providers/openai.ts': [
    'reasoning_effort',
    'buildOpenAIResponsesPayload',
    'buildOpenAIChatPayload',
  ],
  'apps/api/providers/gemini.ts': [
    'function isLikelyFetchableRemoteMediaUrl(',
    'async function assertGeminiRemoteMediaAccessible(',
    'function isLikelyUnsupportedRemoteMediaUrl(',
    'function isGeminiCatalogAuthFailure(',
    'function getCachedGeminiCatalogAuthFailure(',
    'async resolveModelIdForMethod(',
    "method: 'generateContent' | 'streamGenerateContent',",
    "const resolved = await this.resolveModelIdForMethod(activeMessage.model.id, 'generateContent');",
    'private async getModelCatalog(',
    'function mapGemini',
  ],
  'apps/api/providers/handler.ts': [
    'export async function handleProviderRequest(',
    'function selectProvider',
    'let skippedByCooldown = 0;',
    'skippedByCooldown++;',
    'attemptedProviders = attemptedProviderList;',
    'requestRetryWorthless',
    'providerSwitchWorthless',
    'failureOrigin',
    'shouldSkipGeminiProviderForMessage(',
  ],
  'apps/api/modules/errorClassification.ts': [
    'export function isInvalidProviderCredentialError(',
    'export function isProviderAuthConfigurationError(',
    'export function isProviderAuthOrConfigurationError(',
    'export function isToolUnsupportedError(',
    'const geminiRegionalOrCapabilityBlock =',
    "message.includes('resource has been exhausted') ||",
    "message.includes('quota exhausted') ||",
  ],
  'apps/api/modules/openaiRouteUtils.ts': [
    'export function',
    'function normalize',
  ],
  'apps/api/modules/openaiProviderSelection.ts': [
    'export async function getModelCapabilities(',
    'export async function enforceModelCapabilities(',
    'export async function pickOpenAIProviderKey(',
    'function hasRecentRateLimitOrTimeoutSignal(',
    'export async function inspectVideoGenProviderAvailability(',
    'export async function pickAnyXaiProviderKey(',
  ],
  'apps/api/providers/openrouter.ts': [
    'function isOpenRouterToolUseUnsupportedError(',
    'export class OpenRouterAI implements IAIProvider {',
    'async sendMessage(',
    'handleResponseError(',
  ],
  'apps/api/modules/requestQueue.ts': [
    'function getBaselineTierRps()',
    'const REQUEST_QUEUE_CONCURRENCY = (() => {',
    'const REQUEST_QUEUE_MAX_PENDING = (() => {',
    'export const requestQueue = new RequestQueue(',
  ],
  'apps/api/modules/modelUpdater.ts': [
    'function collectAvailabilityConstraintMetadata(',
    'function hasAvailabilityConstraint(',
    'function isProbeEntryEmpty(',
    'function loadBasePricing()',
    'function loadPricingCache()',
    'function normalizeResolvedPricing(',
    'const constrainedModelIds = new Set<string>();',
    'refreshProviderCountsInModelsFile',
  ],
  'apps/api/modules/responsesHistory.ts': [
    'export async function loadResponsesHistoryEntry(',
    'export async function saveResponsesHistoryEntry(',
    'export async function mergeResponsesHistoryInput(',
  ],
  'apps/api/dev/fetchPricing.ts': [
    'function resolveOfficialPricing(',
    'function resolveOpenRouterPricing(',
    'const OFFICIAL_PRICES:',
  ],
  'apps/api/dev/updatemodels.ts': [
    'function collectAvailabilityConstraintMetadata(',
    'function hasAvailabilityConstraint(',
    'function shouldCountProviderModel(',
    'function guessOwnedBy(',
    'function loadJson(',
    'function saveJson(',
    'const constrainedModelIds = new Set<string>();',
    'function main() {',
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

function shouldSkipAutonomousEditContextFile(candidatePath: string, raw: string): boolean {
  const extension = path.extname(String(candidatePath || '').trim()).toLowerCase();
  if (AUTONOMOUS_EDIT_CONTEXT_BINARY_EXTENSIONS.has(extension)) {
    return true;
  }

  if (extension === '.svg' && /\bdata:image\/[a-z0-9.+-]+;base64,/i.test(raw)) {
    return true;
  }

  if (raw.length > 20_000 && /\bdata:image\/[a-z0-9.+-]+;base64,/i.test(raw)) {
    return true;
  }

  return false;
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

function buildHeadTailExcerpt(raw: string, maxCharsPerFile: number): {
  content: string;
  excerptStrategy: 'head-tail';
  anchorHints: string[];
} {
  const gapMarker = '\n/* [excerpt gap] */\n';
  const suffix = `\n/* [truncated original_length=${raw.length}] */`;
  const availableChars = Math.max(1200, maxCharsPerFile - gapMarker.length - suffix.length);
  const headChars = Math.floor(availableChars / 2);
  const tailChars = availableChars - headChars;

  return {
    content: `${raw.slice(0, headChars)}${gapMarker}${raw.slice(Math.max(0, raw.length - tailChars))}${suffix}`,
    excerptStrategy: 'head-tail',
    anchorHints: [],
  };
}

function uniqueAnchors(anchors: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const anchor of anchors) {
    const trimmed = String(anchor || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildAnchoredExcerpt(
  raw: string,
  candidatePath: string,
  maxCharsPerFile: number,
  preferredAnchors: string[] = [],
): {
  content: string;
  excerptStrategy: 'anchored' | 'head-tail';
  anchorHints: string[];
} {
  const anchors = uniqueAnchors([
    ...preferredAnchors,
    ...(LARGE_FILE_AUTONOMOUS_CONTEXT_ANCHORS[candidatePath] || []),
  ]);
  if (anchors.length === 0) {
    return buildHeadTailExcerpt(raw, maxCharsPerFile);
  }

  const excerpts: string[] = [];
  const usedAnchors: string[] = [];
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
    usedAnchors.push(anchor);
  }

  if (excerpts.length === 0) {
    return buildHeadTailExcerpt(raw, maxCharsPerFile);
  }

  return {
    content: `${excerpts.join('\n\n/* [excerpt gap] */\n\n')}\n\n/* [truncated original_length=${raw.length}] */`,
    excerptStrategy: 'anchored',
    anchorHints: usedAnchors,
  };
}

function buildAutonomousEditContextContent(
  raw: string,
  candidatePath: string,
  maxCharsPerFile: number,
  preferredAnchors: string[] = [],
): {
  content: string;
  excerptStrategy: 'full' | 'anchored' | 'head-tail';
  anchorHints: string[];
} {
  if (raw.length <= maxCharsPerFile) {
    return {
      content: raw,
      excerptStrategy: 'full',
      anchorHints: uniqueAnchors(preferredAnchors).slice(0, 6),
    };
  }
  return buildAnchoredExcerpt(raw, candidatePath, maxCharsPerFile, preferredAnchors);
}

function describeAutonomousEditSelectionReason(
  candidatePath: string,
  scopes: string[],
  preferredPaths: string[],
  anchorHints: string[],
): string {
  const reasons: string[] = [];
  if (preferredPaths.includes(candidatePath)) {
    reasons.push('Preferred refresh target from a previous failed autonomous edit.');
  }

  if (candidatePath.startsWith('apps/api/')) {
    reasons.push('API/provider hot path candidate.');
  } else if (candidatePath.startsWith('apps/langgraph-control-plane/')) {
    reasons.push('Control-plane orchestration candidate.');
  } else if (candidatePath.startsWith('apps/anyscan/')) {
    reasons.push('AnyScan Rust service candidate.');
  } else if (candidatePath.startsWith('apps/homepage/') || candidatePath.startsWith('apps/ui/')) {
    reasons.push('Repo surface candidate.');
  } else {
    reasons.push('Repo workspace/build candidate.');
  }

  const normalizedScopes = Array.from(new Set(
    scopes
      .map((scope) => String(scope || '').trim().toLowerCase())
      .filter(Boolean),
  ));
  if (normalizedScopes.length > 0) {
    reasons.push(`Scope coverage: ${normalizedScopes.join(', ')}.`);
  }
  if (anchorHints.length > 0) {
    reasons.push(`Anchor hints available: ${anchorHints.length}.`);
  }

  return reasons.join(' ');
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

function normalizeLineEndings(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n');
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[0].trim().length === 0) trimmed.shift();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim().length === 0) trimmed.pop();
  return trimmed;
}

function getCommonIndentLength(lines: string[]): number {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return 0;
  return Math.min(...nonEmpty.map((line) => {
    const match = line.match(/^[ \t]*/);
    return match ? match[0].length : 0;
  }));
}

function dedentLines(lines: string[]): string[] {
  const commonIndent = getCommonIndentLength(lines);
  if (commonIndent <= 0) return [...lines];
  return lines.map((line) => line.trim().length > 0 ? line.slice(commonIndent) : '');
}

function normalizeLinesForBlockComparison(lines: string[]): string {
  return dedentLines(trimBoundaryBlankLines(lines))
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function getLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function detectWindowIndent(lines: string[]): string {
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const match = firstNonEmpty?.match(/^[ \t]*/);
  return match ? match[0] : '';
}

function reindentBlock(text: string, indent: string): string {
  const dedented = dedentLines(normalizeLineEndings(text).split('\n'));
  return dedented.map((line) => line.trim().length > 0 ? `${indent}${line}` : line).join('\n');
}

type ReplaceAnchorCandidate = {
  text: string;
  relativeLine: number;
};

type AnchorFragmentReplaceWindowResult =
  | { kind: 'unique'; start: number; end: number; indent: string; anchorCount: number }
  | { kind: 'multiple'; count: number }
  | { kind: 'none' };

function buildReplaceAnchorCandidates(find: string, maxCount: number = 6): ReplaceAnchorCandidate[] {
  const findLines = trimBoundaryBlankLines(normalizeLineEndings(find).split('\n'));
  const candidates = findLines
    .map((line, relativeLine) => ({
      text: line.trim(),
      relativeLine,
    }))
    .filter((entry) => entry.text.length > 0);

  if (candidates.length === 0) return [];

  const meaningful = candidates.filter((entry) => entry.text.length >= 12 || /[()[\]{}.:=><'"`]/.test(entry.text));
  const prioritized = meaningful.length >= 2
    ? meaningful
    : [...candidates]
        .sort((left, right) => right.text.length - left.text.length)
        .slice(0, Math.min(3, candidates.length))
        .sort((left, right) => left.relativeLine - right.relativeLine);

  const seen = new Set<string>();
  const unique: ReplaceAnchorCandidate[] = [];
  for (const candidate of prioritized) {
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    unique.push(candidate);
    if (unique.length >= maxCount) break;
  }

  return unique;
}

function findIndentationInsensitiveReplaceWindow(
  current: string,
  find: string,
): { kind: 'unique'; start: number; end: number; indent: string } | { kind: 'multiple'; count: number } | { kind: 'none' } {
  const currentLines = normalizeLineEndings(current).split('\n');
  const findLines = trimBoundaryBlankLines(normalizeLineEndings(find).split('\n'));
  if (findLines.length === 0) return { kind: 'none' };

  const target = normalizeLinesForBlockComparison(findLines);
  if (!target) return { kind: 'none' };

  const lineOffsets = getLineStartOffsets(current);
  const matches: Array<{ start: number; end: number; indent: string }> = [];
  for (let startLine = 0; startLine <= currentLines.length - findLines.length; startLine += 1) {
    const windowLines = currentLines.slice(startLine, startLine + findLines.length);
    if (normalizeLinesForBlockComparison(windowLines) !== target) continue;
    const start = lineOffsets[startLine] ?? 0;
    const end = startLine + findLines.length < lineOffsets.length
      ? lineOffsets[startLine + findLines.length]
      : current.length;
    matches.push({
      start,
      end,
      indent: detectWindowIndent(windowLines),
    });
    if (matches.length > 1) break;
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'multiple', count: matches.length };
  return { kind: 'unique', ...matches[0] };
}

function findAnchorFragmentReplaceWindow(
  current: string,
  find: string,
): AnchorFragmentReplaceWindowResult {
  const currentLines = normalizeLineEndings(current).split('\n');
  const findLines = trimBoundaryBlankLines(normalizeLineEndings(find).split('\n'));
  const anchors = buildReplaceAnchorCandidates(find);
  if (findLines.length === 0 || anchors.length < 2) return { kind: 'none' };

  const firstAnchor = anchors[0];
  const lastAnchor = anchors[anchors.length - 1];
  const searchWindowLineLimit = Math.max(
    findLines.length + 8,
    Math.ceil(findLines.length * 2.5),
    (lastAnchor.relativeLine - firstAnchor.relativeLine) + 4,
  );
  const lineOffsets = getLineStartOffsets(current);
  const matches: Array<{ start: number; end: number; indent: string }> = [];

  for (let startLine = 0; startLine < currentLines.length; startLine += 1) {
    if (!currentLines[startLine].includes(firstAnchor.text)) continue;

    const expectedStartLine = Math.max(0, startLine - firstAnchor.relativeLine);
    const searchEndLineExclusive = Math.min(
      currentLines.length,
      expectedStartLine + Math.max(findLines.length, searchWindowLineLimit),
    );
    const matchedAnchorLines = [startLine];
    let cursor = startLine + 1;
    let matched = true;

    for (const anchor of anchors.slice(1)) {
      let foundLine = -1;
      for (let lineIndex = cursor; lineIndex < searchEndLineExclusive; lineIndex += 1) {
        if (currentLines[lineIndex].includes(anchor.text)) {
          foundLine = lineIndex;
          break;
        }
      }
      if (foundLine < 0) {
        matched = false;
        break;
      }
      matchedAnchorLines.push(foundLine);
      cursor = foundLine + 1;
    }

    if (!matched) continue;

    const expectedEndLineExclusive = Math.min(
      currentLines.length,
      matchedAnchorLines[matchedAnchorLines.length - 1] + (findLines.length - lastAnchor.relativeLine),
    );
    const windowLineCount = expectedEndLineExclusive - expectedStartLine;
    if (windowLineCount < 1) continue;
    if (windowLineCount > Math.max(findLines.length * 4, findLines.length + 20)) continue;

    const start = lineOffsets[expectedStartLine] ?? 0;
    const end = expectedEndLineExclusive < lineOffsets.length
      ? lineOffsets[expectedEndLineExclusive]
      : current.length;
    const indent = detectWindowIndent(currentLines.slice(expectedStartLine, expectedEndLineExclusive));
    matches.push({ start, end, indent });
    if (matches.length > 1) break;
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'multiple', count: matches.length };
  return { kind: 'unique', ...matches[0], anchorCount: anchors.length };
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

  if (normalizedAllowlist.includes('*')) {
    return { allowed: true, normalizedPath: repoRelativePath, reason: 'Allowed by wildcard allowlist.' };
  }

  if (!normalizedAllowlist.some((allowEntry) => pathMatchesPrefix(repoRelativePath, allowEntry))) {
    return { allowed: false, normalizedPath: repoRelativePath, reason: 'Path is outside the autonomous edit allowlist.' };
  }

  return { allowed: true, normalizedPath: repoRelativePath, reason: 'Allowed.' };
}

export function buildAutonomousEditCandidatePaths(scopes: string[]): string[] {
  const normalizedScopes = Array.from(new Set(scopes.map((scope) => String(scope || '').trim().toLowerCase()).filter(Boolean)));
  const candidates = new Set<string>([
    'package.json',
    'turbo.json',
    'bun.sh',
    'README.md',
    'apps/langgraph-control-plane/src/index.ts',
    'apps/langgraph-control-plane/src/autonomousEdits.ts',
    'apps/langgraph-control-plane/src/workflow.ts',
    'apps/langgraph-control-plane/README.md',
  ]);

  const hasAnyScope = (...scopeIds: string[]): boolean =>
    scopeIds.some((scopeId) => normalizedScopes.includes(scopeId));

  if (normalizedScopes.includes('repo') || normalizedScopes.includes('control-plane')) {
    candidates.add('apps/langgraph-control-plane/package.json');
  }

  if (hasAnyScope('repo', 'api', 'api-experimental', 'api-routing', 'api-runtime', 'api-data', 'api-platform')) {
    candidates.add('apps/api/providers/openai.ts');
    candidates.add('apps/api/providers/gemini.ts');
    candidates.add('apps/api/providers/deepseek.ts');
    candidates.add('apps/api/providers/imagen.ts');
    candidates.add('apps/api/providers/interfaces.ts');
    candidates.add('apps/api/providers/openrouter.ts');
    candidates.add('apps/api/providers/handler.ts');
    candidates.add('apps/api/modules/adminKeySync.ts');
    candidates.add('apps/api/modules/dataManager.ts');
    candidates.add('apps/api/modules/db.ts');
    candidates.add('apps/api/modules/errorClassification.ts');
    candidates.add('apps/api/modules/errorLogger.ts');
    candidates.add('apps/api/modules/geminiMediaValidation.ts');
    candidates.add('apps/api/modules/keyChecker.ts');
    candidates.add('apps/api/modules/middlewareFactory.ts');
    candidates.add('apps/api/modules/modelUpdater.ts');
    candidates.add('apps/api/modules/openaiFallbacks.ts');
    candidates.add('apps/api/modules/openaiProviderSelection.ts');
    candidates.add('apps/api/modules/openaiRequestSupport.ts');
    candidates.add('apps/api/modules/openaiRouteSupport.ts');
    candidates.add('apps/api/modules/openaiRouteUtils.ts');
    candidates.add('apps/api/modules/openaiResponsesFormat.ts');
    candidates.add('apps/api/modules/rateLimit.ts');
    candidates.add('apps/api/modules/rateLimitRedis.ts');
    candidates.add('apps/api/modules/requestIntake.ts');
    candidates.add('apps/api/modules/requestQueue.ts');
    candidates.add('apps/api/modules/responsesHistory.ts');
    candidates.add('apps/api/modules/tokenEstimation.ts');
    candidates.add('apps/api/modules/userData.ts');
    candidates.add('apps/api/dev/applyProbeCapabilities.ts');
    candidates.add('apps/api/dev/checkModelCapabilities.ts');
    candidates.add('apps/api/dev/fetchPricing.ts');
    candidates.add('apps/api/dev/models.ts');
    candidates.add('apps/api/dev/refreshModels.ts');
    candidates.add('apps/api/dev/testModelLiveProbes.ts');
    candidates.add('apps/api/dev/updatemodels.ts');
    candidates.add('apps/api/dev/updateproviders.ts');
    candidates.add('apps/api/routes/openai.ts');
    candidates.add('apps/api/routes/models.ts');
    candidates.add('apps/api/server.ts');
    candidates.add('apps/api/server.launcher.bun.ts');
    candidates.add('apps/api/anygpt-api.service');
    candidates.add('apps/api/anygpt-experimental.service');
    candidates.add('apps/api/models.json');
    candidates.add('apps/api/pricing.json');
    candidates.add('apps/api/README.md');
    candidates.add('apps/api/package.json');
    candidates.add('apps/api/ws/wsServer.ts');
  }

  if (hasAnyScope('repo', 'anyscan')) {
    candidates.add('apps/anyscan/Cargo.toml');
    candidates.add('apps/anyscan/index.html');
    candidates.add('apps/anyscan/deploy.sh');
    candidates.add('apps/anyscan/anyscan-api.service');
    candidates.add('apps/anyscan/anyscan-worker.service');
    candidates.add('apps/anyscan/src/config.rs');
    candidates.add('apps/anyscan/src/core.rs');
    candidates.add('apps/anyscan/src/detectors.rs');
    candidates.add('apps/anyscan/src/dragonfly_store.rs');
    candidates.add('apps/anyscan/src/fetcher.rs');
    candidates.add('apps/anyscan/src/lib.rs');
    candidates.add('apps/anyscan/src/ops.rs');
    candidates.add('apps/anyscan/src/store.rs');
    candidates.add('apps/anyscan/src/bin/anyscan-api.rs');
    candidates.add('apps/anyscan/src/bin/anyscan-worker.rs');
  }

  if (hasAnyScope('api-routing')) {
    candidates.add('apps/api/providers/handler.ts');
    candidates.add('apps/api/providers/openrouter.ts');
    candidates.add('apps/api/routes/openai.ts');
    candidates.add('apps/api/modules/openaiProviderSelection.ts');
    candidates.add('apps/api/modules/openaiRequestSupport.ts');
    candidates.add('apps/api/modules/openaiRouteSupport.ts');
    candidates.add('apps/api/modules/openaiRouteUtils.ts');
    candidates.add('apps/api/modules/openaiResponsesFormat.ts');
    candidates.add('apps/api/modules/geminiMediaValidation.ts');
    candidates.add('apps/api/modules/responsesHistory.ts');
  }

  if (hasAnyScope('api-runtime')) {
    candidates.add('apps/api/modules/requestQueue.ts');
    candidates.add('apps/api/modules/requestIntake.ts');
    candidates.add('apps/api/modules/rateLimit.ts');
    candidates.add('apps/api/modules/rateLimitRedis.ts');
    candidates.add('apps/api/modules/tokenEstimation.ts');
    candidates.add('apps/api/modules/userData.ts');
    candidates.add('apps/api/modules/errorClassification.ts');
    candidates.add('apps/api/modules/errorLogger.ts');
    candidates.add('apps/api/modules/middlewareFactory.ts');
  }

  if (hasAnyScope('api-data')) {
    candidates.add('apps/api/models.json');
    candidates.add('apps/api/pricing.json');
    candidates.add('apps/api/routes/models.ts');
    candidates.add('apps/api/modules/modelUpdater.ts');
    candidates.add('apps/api/modules/dataManager.ts');
    candidates.add('apps/api/modules/adminKeySync.ts');
    candidates.add('apps/api/modules/keyChecker.ts');
    candidates.add('apps/api/modules/db.ts');
    candidates.add('apps/api/dev/fetchPricing.ts');
    candidates.add('apps/api/dev/checkModelCapabilities.ts');
    candidates.add('apps/api/dev/refreshModels.ts');
    candidates.add('apps/api/dev/updatemodels.ts');
    candidates.add('apps/api/dev/updateproviders.ts');
    candidates.add('apps/api/README.md');
    candidates.add('apps/api/package.json');
  }

  if (hasAnyScope('api-platform')) {
    candidates.add('apps/api/server.ts');
    candidates.add('apps/api/server.launcher.bun.ts');
    candidates.add('apps/api/ws/wsServer.ts');
    candidates.add('apps/api/anygpt-api.service');
    candidates.add('apps/api/anygpt-experimental.service');
  }

  if (normalizedScopes.includes('repo') || normalizedScopes.includes('control-plane')) {
    candidates.add('apps/langgraph-control-plane/langgraph.json');
    candidates.add('apps/langgraph-control-plane/governance-profiles.json');
    candidates.add('apps/langgraph-control-plane/src/langsmithClient.ts');
    candidates.add('apps/langgraph-control-plane/src/studioGraph.ts');
    candidates.add('apps/langgraph-control-plane/src/autonomousSkills.ts');
  }

  if (normalizedScopes.includes('research-scout')) {
    candidates.add('apps/langgraph-control-plane/src/workflow.ts');
    candidates.add('apps/langgraph-control-plane/src/autonomousEdits.ts');
    candidates.add('apps/langgraph-control-plane/src/autonomousSkills.ts');
    candidates.add('apps/langgraph-control-plane/src/index.ts');
    candidates.add('apps/langgraph-control-plane/README.md');
  }

  if (hasAnyScope('repo', 'repo-surface', 'workspace-surface', 'homepage-surface', 'ui-surface')) {
    candidates.add('tsconfig.json');
    candidates.add('pnpm-workspace.yaml');
    candidates.add('SETUP.md');
    candidates.add('scripts/run-frontend-stack.sh');
    candidates.add('scripts/with-bun-path.sh');
    candidates.add('apps/homepage/package.json');
    candidates.add('apps/homepage/serve.js');
    candidates.add('apps/homepage/public/index.html');
    candidates.add('apps/homepage/public/script.js');
    candidates.add('apps/homepage/public/style.css');
    candidates.add('apps/ui/package.json');
    candidates.add('apps/ui/README.md');
    candidates.add('apps/ui/librechat/client/index.html');
    candidates.add('apps/ui/librechat/client/src/App.jsx');
    candidates.add('apps/ui/librechat/client/src/main.jsx');
    candidates.add('apps/ui/librechat/client/src/style.css');
    candidates.add('apps/ui/scripts/dev.sh');
    candidates.add('apps/ui/scripts/start.sh');
    candidates.add('apps/ui/scripts/stop.sh');
    candidates.add('apps/ui/scripts/sync-config.sh');
    candidates.add('apps/ui/scripts/sync-librechat.sh');
  }

  if (hasAnyScope('homepage-surface')) {
    candidates.add('apps/homepage/package.json');
    candidates.add('apps/homepage/serve.js');
    candidates.add('apps/homepage/public/index.html');
    candidates.add('apps/homepage/public/script.js');
    candidates.add('apps/homepage/public/style.css');
  }

  if (hasAnyScope('ui-surface')) {
    candidates.add('apps/ui/package.json');
    candidates.add('apps/ui/README.md');
    candidates.add('apps/ui/librechat/client/index.html');
    candidates.add('apps/ui/librechat/client/src/App.jsx');
    candidates.add('apps/ui/librechat/client/src/main.jsx');
    candidates.add('apps/ui/librechat/client/src/style.css');
    candidates.add('apps/ui/scripts/dev.sh');
    candidates.add('apps/ui/scripts/start.sh');
    candidates.add('apps/ui/scripts/stop.sh');
    candidates.add('apps/ui/scripts/sync-config.sh');
    candidates.add('apps/ui/scripts/sync-librechat.sh');
  }

  return Array.from(candidates);
}

export function readAutonomousEditContext(
  repoRoot: string,
  scopes: string[],
  allowlist: string[],
  denylist: string[],
  options: ReadAutonomousEditContextOptions = {},
): AutonomousEditContextFile[] {
  const maxCharsPerFile = options.maxCharsPerFile ?? 12000;
  const preferredAnchorsByPath = options.preferredAnchorsByPath || {};
  const preferredPaths = (options.preferredPaths || [])
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter(Boolean);
  const maxFiles = typeof options.maxFiles === 'number' && Number.isFinite(options.maxFiles)
    ? Math.max(1, Math.floor(options.maxFiles))
    : Number.POSITIVE_INFINITY;
  const files: AutonomousEditContextFile[] = [];
  const candidatePaths = preferredPaths.length > 0
    ? Array.from(new Set([...preferredPaths, ...buildAutonomousEditCandidatePaths(scopes)]))
    : buildAutonomousEditCandidatePaths(scopes);

  for (const candidatePath of candidatePaths) {
    const check = checkAutonomousEditPath(repoRoot, candidatePath, allowlist, denylist);
    if (!check.allowed) continue;
    if (preferredPaths.length > 0 && !preferredPaths.includes(check.normalizedPath)) continue;

    const absolutePath = path.resolve(repoRoot, check.normalizedPath);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const raw = fs.readFileSync(absolutePath, 'utf8');
      if (shouldSkipAutonomousEditContextFile(check.normalizedPath, raw)) {
        continue;
      }
      const anchorHints = uniqueAnchors(preferredAnchorsByPath[check.normalizedPath] || []).slice(0, 6);
      const excerpt = buildAutonomousEditContextContent(
        raw,
        check.normalizedPath,
        maxCharsPerFile,
        anchorHints,
      );
      const truncated = raw.length > maxCharsPerFile;
      files.push({
        path: check.normalizedPath,
        content: excerpt.content,
        truncated,
        rawCharCount: raw.length,
        selectionReason: describeAutonomousEditSelectionReason(
          check.normalizedPath,
          scopes,
          preferredPaths,
          excerpt.anchorHints.length > 0 ? excerpt.anchorHints : anchorHints,
        ),
        excerptStrategy: excerpt.excerptStrategy,
        anchorHints: excerpt.anchorHints.length > 0 ? excerpt.anchorHints : anchorHints,
      });
      if (files.length >= maxFiles) break;
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

function buildNormalizedFailedEdit(action: AutonomousEditAction, normalizedPath: string, message: string): AppliedAutonomousEdit {
  return AppliedAutonomousEditSchema.parse({
    ...action,
    path: normalizedPath || normalizeRepoRelativePath(action.path),
    status: 'failed',
    message,
  });
}

function buildNormalizedSkippedEdit(action: AutonomousEditAction, normalizedPath: string, message: string): AppliedAutonomousEdit {
  return AppliedAutonomousEditSchema.parse({
    ...action,
    path: normalizedPath || normalizeRepoRelativePath(action.path),
    status: 'skipped',
    message,
  });
}

const AUTONOMOUS_EDIT_TYPESCRIPT_DIAGNOSTIC_CODES = new Set([6133, 2300, 2393, 2451]);

type AutonomousEditTypeScriptDiagnostic = {
  code: number;
  message: string;
};

type AutonomousEditPostValidationResult =
  | { ok: true; message?: string }
  | { ok: false; message: string };

function collectTypeScriptDiagnosticsForFile(
  filePath: string,
  sourceText: string,
): AutonomousEditTypeScriptDiagnostic[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: ['node'],
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: false,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    esModuleInterop: true,
  };

  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  const normalizedFilePath = path.resolve(filePath);
  const normalizedSourceText = String(sourceText || '');

  compilerHost.getSourceFile = (candidateFileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const resolvedCandidate = path.resolve(candidateFileName);
    if (resolvedCandidate === normalizedFilePath) {
      return ts.createSourceFile(candidateFileName, normalizedSourceText, languageVersion, true);
    }
    return originalGetSourceFile(candidateFileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const originalReadFile = compilerHost.readFile?.bind(compilerHost);
  compilerHost.readFile = (candidateFileName) => {
    const resolvedCandidate = path.resolve(candidateFileName);
    if (resolvedCandidate === normalizedFilePath) {
      return normalizedSourceText;
    }
    return originalReadFile ? originalReadFile(candidateFileName) : undefined;
  };

  const originalFileExists = compilerHost.fileExists?.bind(compilerHost);
  compilerHost.fileExists = (candidateFileName) => {
    const resolvedCandidate = path.resolve(candidateFileName);
    if (resolvedCandidate === normalizedFilePath) {
      return true;
    }
    return originalFileExists ? originalFileExists(candidateFileName) : false;
  };

  compilerHost.writeFile = () => {};

  const program = ts.createProgram([normalizedFilePath], compilerOptions, compilerHost);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => AUTONOMOUS_EDIT_TYPESCRIPT_DIAGNOSTIC_CODES.has(diagnostic.code))
    .filter((diagnostic) => diagnostic.file && path.resolve(diagnostic.file.fileName) === normalizedFilePath)
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').trim(),
    }))
    .filter((diagnostic) => Boolean(diagnostic.message));
}

function buildTypeScriptDiagnosticFailureMessage(
  diagnostics: AutonomousEditTypeScriptDiagnostic[],
): string {
  const uniqueDiagnostics = Array.from(new Map(
    diagnostics
      .map((entry) => [entry.code, String(entry.message || '').trim()] as const)
      .filter(([, message]) => Boolean(message)),
  ).entries()).map(([code, message]) => ({ code, message }));

  const preview = uniqueDiagnostics.slice(0, 3).map((entry) => entry.message).join(' | ');
  const suffix = uniqueDiagnostics.length > 3 ? ` (+${uniqueDiagnostics.length - 3} more)` : '';
  if (uniqueDiagnostics.every((entry) => entry.code === 6133)) {
    return `Autonomous edit introduced unused local symbols and was rejected: ${preview}${suffix}`;
  }
  if (uniqueDiagnostics.some((entry) => entry.code === 2451 || entry.code === 2300 || entry.code === 2393)) {
    return `Autonomous edit introduced duplicate declarations and was rejected: ${preview}${suffix}`;
  }
  return `Autonomous edit introduced same-file TypeScript diagnostics and was rejected: ${preview}${suffix}`;
}

function validateAutonomousEditTypeScriptDiagnostics(
  absolutePath: string,
  nextContent: string,
): { ok: true } | { ok: false; message: string } {
  if (!absolutePath.endsWith('.ts') && !absolutePath.endsWith('.tsx')) {
    return { ok: true };
  }

  const diagnostics = collectTypeScriptDiagnosticsForFile(absolutePath, nextContent);
  if (diagnostics.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    message: buildTypeScriptDiagnosticFailureMessage(diagnostics),
  };
}

function buildInvalidJsonFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Autonomous edit produced invalid JSON and was rejected: ${detail}`;
}

function findDuplicatePackageJsonScriptKeys(sourceText: string): string[] {
  const source = String(sourceText || '');
  if (!source.trim()) return [];

  const duplicates = new Set<string>();
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < source.length && /\s/.test(source[index]!)) {
      index += 1;
    }
  };

  const expect = (char: string): void => {
    if (source[index] !== char) {
      throw new Error(`expected ${char}`);
    }
    index += 1;
  };

  const readString = (): string => {
    expect('"');
    let value = '';
    let escape = false;
    while (index < source.length) {
      const char = source[index]!;
      index += 1;
      if (escape) {
        value += char;
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        return value;
      }
      value += char;
    }
    throw new Error('unterminated string');
  };

  const skipPrimitive = (): void => {
    while (index < source.length && !/[\s,\]}]/.test(source[index]!)) {
      index += 1;
    }
  };

  const skipValue = (): void => {
    skipWhitespace();
    const char = source[index];
    if (char === '"') {
      readString();
      return;
    }
    if (char === '{') {
      skipObject();
      return;
    }
    if (char === '[') {
      skipArray();
      return;
    }
    skipPrimitive();
  };

  const skipArray = (): void => {
    expect('[');
    skipWhitespace();
    while (index < source.length && source[index] !== ']') {
      skipValue();
      skipWhitespace();
      if (source[index] === ',') {
        index += 1;
        skipWhitespace();
      }
    }
    expect(']');
  };

  const skipObject = (): void => {
    expect('{');
    skipWhitespace();
    while (index < source.length && source[index] !== '}') {
      readString();
      skipWhitespace();
      expect(':');
      skipWhitespace();
      skipValue();
      skipWhitespace();
      if (source[index] === ',') {
        index += 1;
        skipWhitespace();
      }
    }
    expect('}');
  };

  const scanScriptsObject = (): void => {
    expect('{');
    skipWhitespace();
    const seen = new Set<string>();
    while (index < source.length && source[index] !== '}') {
      const key = readString();
      if (seen.has(key)) {
        duplicates.add(key);
      } else {
        seen.add(key);
      }
      skipWhitespace();
      expect(':');
      skipWhitespace();
      skipValue();
      skipWhitespace();
      if (source[index] === ',') {
        index += 1;
        skipWhitespace();
      }
    }
    expect('}');
  };

  skipWhitespace();
  expect('{');
  skipWhitespace();
  while (index < source.length && source[index] !== '}') {
    const key = readString();
    skipWhitespace();
    expect(':');
    skipWhitespace();
    if (key === 'scripts' && source[index] === '{') {
      scanScriptsObject();
    } else {
      skipValue();
    }
    skipWhitespace();
    if (source[index] === ',') {
      index += 1;
      skipWhitespace();
    }
  }

  return Array.from(duplicates);
}

function buildDuplicatePackageJsonScriptsFailureMessage(keys: string[]): string {
  const uniqueKeys = Array.from(new Set(
    keys
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  ));
  const preview = uniqueKeys.slice(0, 4).join(', ');
  const suffix = uniqueKeys.length > 4 ? ` (+${uniqueKeys.length - 4} more)` : '';
  return `Autonomous edit introduced duplicate package.json scripts and was rejected: ${preview}${suffix}`;
}

function validateAutonomousEditJson(
  absolutePath: string,
  nextContent: string,
): { ok: true } | { ok: false; message: string } {
  if (!absolutePath.endsWith('.json')) {
    return { ok: true };
  }

  try {
    JSON.parse(nextContent);
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      message: buildInvalidJsonFailureMessage(error),
    };
  }
}

function validateAutonomousEditPackageJson(
  absolutePath: string,
  nextContent: string,
): { ok: true } | { ok: false; message: string } {
  if (path.basename(absolutePath) !== 'package.json') {
    return { ok: true };
  }

  const duplicateScriptKeys = findDuplicatePackageJsonScriptKeys(nextContent);
  if (duplicateScriptKeys.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    message: buildDuplicatePackageJsonScriptsFailureMessage(duplicateScriptKeys),
  };
}

function validateAutonomousEditContent(
  absolutePath: string,
  nextContent: string,
): { ok: true } | { ok: false; message: string } {
  const jsonValidation = validateAutonomousEditJson(absolutePath, nextContent);
  if (!jsonValidation.ok) {
    return jsonValidation;
  }
  const packageJsonValidation = validateAutonomousEditPackageJson(absolutePath, nextContent);
  if (!packageJsonValidation.ok) {
    return packageJsonValidation;
  }
  return validateAutonomousEditTypeScriptDiagnostics(absolutePath, nextContent);
}

function shouldRunControlPlanePostEditTypecheck(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith('apps/langgraph-control-plane/')) return false;
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(normalizedPath)
    || /(?:package\.json|tsconfig\.json|langgraph\.json|governance-profiles\.json)$/i.test(normalizedPath);
}

function shouldRunApiPostEditTypecheck(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith('apps/api/')) return false;
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(normalizedPath)
    || /(?:package\.json|tsconfig\.json)$/i.test(normalizedPath);
}

function shouldRunAnyScanPostEditCheck(normalizedPath: string): boolean {
  if (!normalizedPath.startsWith('apps/anyscan/')) return false;
  return /\.(?:rs)$/i.test(normalizedPath)
    || /(?:Cargo\.toml)$/i.test(normalizedPath);
}

function sanitizePostEditValidatorOutput(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(' | ')
    .slice(0, 900);
}

function runPostEditValidatorCommand(
  repoRoot: string,
  normalizedPath: string,
  label: string,
  command: string[],
): AutonomousEditPostValidationResult {
  const commandPreview = command.join(' ');
  const result = spawnSync(command[0] || '', command.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  const combinedOutput = sanitizePostEditValidatorOutput(
    `${result.stdout || ''}\n${result.stderr || ''}`,
  );

  if (result.error) {
    return {
      ok: false,
      message: `Post-edit validator ${label} failed to start for ${normalizedPath}: ${result.error.message}. Command: ${commandPreview}`,
    };
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    return {
      ok: false,
      message: `Post-edit validator ${label} failed for ${normalizedPath}: ${combinedOutput || `exit ${result.status}`}. Command: ${commandPreview}`,
    };
  }

  return {
    ok: true,
    message: `Post-edit validator ${label} passed for ${normalizedPath}.`,
  };
}

function runAutonomousEditPostValidation(
  repoRoot: string,
  normalizedPath: string,
): AutonomousEditPostValidationResult {
  if (shouldRunControlPlanePostEditTypecheck(normalizedPath)) {
    return runPostEditValidatorCommand(
      repoRoot,
      normalizedPath,
      'control-plane typecheck',
      ['bash', './bun.sh', 'run', '-F', 'anygpt-langgraph-control-plane', 'typecheck'],
    );
  }

  if (shouldRunApiPostEditTypecheck(normalizedPath)) {
    return {
      ok: true,
      message: `Post-edit validator api file-level checks passed for ${normalizedPath}; full API typecheck is deferred to repair smoke validation.`,
    };
  }

  if (shouldRunAnyScanPostEditCheck(normalizedPath)) {
    return runPostEditValidatorCommand(
      repoRoot,
      normalizedPath,
      'anyscan cargo check',
      ['cargo', 'check', '--manifest-path', 'apps/anyscan/Cargo.toml'],
    );
  }

  return { ok: true };
}

function ensureTouchedFileSnapshot(
  repoRoot: string,
  normalizedPath: string,
  touchedFiles: Map<string, AutonomousEditTouchedFile>,
): AutonomousEditTouchedFile {
  const existing = touchedFiles.get(normalizedPath);
  if (existing) return existing;
  const snapshot = captureTouchedFileSnapshot(repoRoot, normalizedPath);
  touchedFiles.set(normalizedPath, snapshot);
  return snapshot;
}

function restoreTouchedFileSnapshot(
  repoRoot: string,
  snapshot: AutonomousEditTouchedFile,
): void {
  const absolutePath = path.resolve(repoRoot, snapshot.path);
  if (snapshot.existedBefore) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, snapshot.beforeContent, 'utf8');
    return;
  }

  fs.rmSync(absolutePath, { force: true });
}

function applyAutonomousEditFileWrite(
  repoRoot: string,
  normalizedPath: string,
  nextContent: string,
  touchedFiles: Map<string, AutonomousEditTouchedFile>,
  successMessage: string,
): { ok: true; message: string } | { ok: false; message: string } {
  const snapshot = ensureTouchedFileSnapshot(repoRoot, normalizedPath, touchedFiles);
  const absolutePath = path.resolve(repoRoot, normalizedPath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, nextContent, 'utf8');

  const postValidation = runAutonomousEditPostValidation(repoRoot, normalizedPath);
  if (!postValidation.ok) {
    restoreTouchedFileSnapshot(repoRoot, snapshot);
    touchedFiles.delete(normalizedPath);
    return {
      ok: false,
      message: postValidation.message,
    };
  }

  return {
    ok: true,
    message: [successMessage, postValidation.message].filter(Boolean).join(' '),
  };
}

function previewReplaceActionContent(
  current: string,
  find: string,
  replace: string,
): { ok: true; nextContent: string } | { ok: false; message: string } {
  const matchCount = countOccurrences(current, find);
  if (matchCount > 1) {
    return {
      ok: false,
      message: `Replace target text matched ${matchCount} times in the file; provide a more specific anchored block.`,
    };
  }

  if (matchCount === 0) {
    const indentationInsensitiveMatch = findIndentationInsensitiveReplaceWindow(current, find);
    if (indentationInsensitiveMatch.kind === 'multiple') {
      return {
        ok: false,
        message: `Replace target text was not found exactly and indentation-insensitive matching found ${indentationInsensitiveMatch.count} candidate blocks; provide a more specific anchored block.`,
      };
    }
    if (indentationInsensitiveMatch.kind === 'unique') {
      return {
        ok: true,
        nextContent: `${current.slice(0, indentationInsensitiveMatch.start)}${reindentBlock(replace, indentationInsensitiveMatch.indent)}${current.slice(indentationInsensitiveMatch.end)}`,
      };
    }

    const anchorFragmentMatch = findAnchorFragmentReplaceWindow(current, find);
    if (anchorFragmentMatch.kind === 'multiple') {
      return {
        ok: false,
        message: `Replace target text was not found exactly and anchor-fragment matching found ${anchorFragmentMatch.count} candidate blocks; provide a more specific anchored block.`,
      };
    }
    if (anchorFragmentMatch.kind === 'unique') {
      return {
        ok: true,
        nextContent: `${current.slice(0, anchorFragmentMatch.start)}${reindentBlock(replace, anchorFragmentMatch.indent)}${current.slice(anchorFragmentMatch.end)}`,
      };
    }

    return {
      ok: false,
      message: buildReplaceFailureDiagnostic(current, find),
    };
  }

  return {
    ok: true,
    nextContent: current.replace(find, replace),
  };
}

export function preflightAutonomousEditAction(
  repoRoot: string,
  action: AutonomousEditAction,
  allowlist: string[],
  denylist: string[],
): AppliedAutonomousEdit | null {
  const check = checkAutonomousEditPath(repoRoot, action.path, allowlist, denylist);
  if (!check.allowed) {
    return buildNormalizedFailedEdit(action, check.normalizedPath, check.reason);
  }

  const absolutePath = path.resolve(repoRoot, check.normalizedPath);
  if (action.type === 'replace') {
    const find = typeof action.find === 'string' ? action.find : '';
    const replace = typeof action.replace === 'string' ? action.replace : '';
    if (!find) {
      return buildNormalizedFailedEdit(action, check.normalizedPath, 'Replace action is missing a find string.');
    }
    if (!fs.existsSync(absolutePath)) {
      return buildNormalizedFailedEdit(action, check.normalizedPath, 'Replace target file does not exist.');
    }

    const current = fs.readFileSync(absolutePath, 'utf8');
    const preview = previewReplaceActionContent(current, find, replace);
    if (!preview.ok) {
      return buildNormalizedFailedEdit(action, check.normalizedPath, preview.message);
    }

    if (preview.nextContent === current) {
      return buildNormalizedFailedEdit(action, check.normalizedPath, 'No content change was produced by the replace action.');
    }

    const contentValidation = validateAutonomousEditContent(absolutePath, preview.nextContent);
    if (!contentValidation.ok) {
      return buildNormalizedFailedEdit(action, check.normalizedPath, contentValidation.message);
    }
    return null;
  }

  const content = typeof action.content === 'string' ? action.content : '';
  if (!content) {
    return buildNormalizedFailedEdit(action, check.normalizedPath, 'Write action is missing content.');
  }
  if (fs.existsSync(absolutePath) && fs.readFileSync(absolutePath, 'utf8') === content) {
    return buildNormalizedFailedEdit(action, check.normalizedPath, 'Write action produced no content change.');
  }
  const contentValidation = validateAutonomousEditContent(absolutePath, content);
  if (!contentValidation.ok) {
    return buildNormalizedFailedEdit(action, check.normalizedPath, contentValidation.message);
  }
  return null;
}

export function applyAutonomousEditsWithManifest(
  repoRoot: string,
  actions: AutonomousEditAction[],
  allowlist: string[],
  denylist: string[],
): { appliedEdits: AppliedAutonomousEdit[]; sessionManifest: AutonomousEditSessionManifest } {
  const requestedActions = actions.map((action) => AutonomousEditActionSchema.parse(action));
  const manifest = buildAutonomousEditSessionManifest(requestedActions);
  const touchedFiles = new Map<string, AutonomousEditTouchedFile>();
  const resultsByIndex = new Map<number, AppliedAutonomousEdit>();
  const preflightResults = requestedActions.map((action, index) => ({
    index,
    action,
    normalizedPath: normalizeRepoRelativePath(action.path),
    failure: preflightAutonomousEditAction(repoRoot, action, allowlist, denylist),
  }));
  const preflightFailures = preflightResults.filter((entry): entry is typeof entry & { failure: AppliedAutonomousEdit } => Boolean(entry.failure));
  let actionsToApply = preflightResults.filter((entry) => !entry.failure);

  if (preflightFailures.length > 0) {
    const failedPaths = new Set(
      preflightFailures
        .map((entry) => String(entry.failure.path || entry.normalizedPath).trim())
        .filter(Boolean),
    );
    const siblingPathSkips = actionsToApply.filter((entry) => failedPaths.has(entry.normalizedPath));
    const unaffectedActions = actionsToApply.filter((entry) => !failedPaths.has(entry.normalizedPath));

    if (unaffectedActions.length === 0) {
      for (const entry of preflightFailures) {
        resultsByIndex.set(entry.index, entry.failure);
      }
      for (const entry of siblingPathSkips) {
        resultsByIndex.set(
          entry.index,
          buildNormalizedSkippedEdit(
            entry.action,
            entry.normalizedPath,
            'Autonomous edit batch was not applied because another edit targeting the same path failed preflight validation.',
          ),
        );
      }

      const orderedResults = preflightResults
        .map((entry) => resultsByIndex.get(entry.index))
        .filter((result): result is AppliedAutonomousEdit => Boolean(result));

      return {
        appliedEdits: orderedResults,
        sessionManifest: AutonomousEditSessionManifestSchema.parse({
          ...manifest,
          appliedEdits: orderedResults,
          touchedFiles: [],
          rollbackStatus: 'not-required',
        }),
      };
    }

    for (const entry of preflightFailures) {
      resultsByIndex.set(
        entry.index,
        buildNormalizedSkippedEdit(
          entry.action,
          String(entry.failure.path || entry.normalizedPath).trim(),
          `Skipped preflight-invalid autonomous edit while applying other valid edits in the batch: ${entry.failure.message}`,
        ),
      );
    }
    for (const entry of siblingPathSkips) {
      resultsByIndex.set(
        entry.index,
        buildNormalizedSkippedEdit(
          entry.action,
          entry.normalizedPath,
          'Skipped because another autonomous edit targeting the same path failed preflight validation; leaving this path unchanged for this batch.',
        ),
      );
    }

    actionsToApply = unaffectedActions;
  }

  for (const { index, action } of actionsToApply) {
    const check = checkAutonomousEditPath(repoRoot, action.path, allowlist, denylist);
    if (!check.allowed) {
      resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
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
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: 'Replace action is missing a find string.',
          }));
          continue;
        }
        if (!fs.existsSync(absolutePath)) {
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
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
          const indentationInsensitiveMatch = findIndentationInsensitiveReplaceWindow(current, find);
          if (indentationInsensitiveMatch.kind === 'multiple') {
            resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
              ...action,
              path: check.normalizedPath,
              status: 'failed',
              message: `Replace target text was not found exactly and indentation-insensitive matching found ${indentationInsensitiveMatch.count} candidate blocks; provide a more specific anchored block.`,
            }));
            continue;
          }

          if (indentationInsensitiveMatch.kind === 'unique') {
            const replacement = reindentBlock(replace, indentationInsensitiveMatch.indent);
            const next = `${current.slice(0, indentationInsensitiveMatch.start)}${replacement}${current.slice(indentationInsensitiveMatch.end)}`;
            if (next === current) {
              resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
                ...action,
                path: check.normalizedPath,
                status: 'skipped',
                message: 'No content change was produced by the indentation-insensitive replace action.',
              }));
              continue;
            }

            const contentValidation = validateAutonomousEditContent(absolutePath, next);
            if (!contentValidation.ok) {
              resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
                ...action,
                path: check.normalizedPath,
                status: 'failed',
                message: contentValidation.message,
              }));
              continue;
            }

            const applied = applyAutonomousEditFileWrite(
              repoRoot,
              check.normalizedPath,
              next,
              touchedFiles,
              'Replace action applied successfully using indentation-insensitive block matching.',
            );
            resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
              ...action,
              path: check.normalizedPath,
              status: applied.ok ? 'applied' : 'failed',
              message: applied.message,
            }));
            continue;
          }

          const anchorFragmentMatch = findAnchorFragmentReplaceWindow(current, find);
          if (anchorFragmentMatch.kind === 'multiple') {
            const anchorFragmentFailure = AppliedAutonomousEditSchema.parse({
              ...action,
              path: check.normalizedPath,
              status: 'failed',
              message: `Replace target text was not found exactly and anchor-fragment matching found ${anchorFragmentMatch.count} candidate blocks; provide a more specific anchored block.`,
            });
            resultsByIndex.set(index, anchorFragmentFailure);
            continue;
          }
          if (anchorFragmentMatch.kind === 'unique') {
            const replacement = reindentBlock(replace, anchorFragmentMatch.indent);
            const next = `${current.slice(0, anchorFragmentMatch.start)}${replacement}${current.slice(anchorFragmentMatch.end)}`;
            if (next === current) {
              resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
                ...action,
                path: check.normalizedPath,
                status: 'skipped',
                message: 'No content change was produced by the anchor-fragment replace action.',
              }));
              continue;
            }

            const contentValidation = validateAutonomousEditContent(absolutePath, next);
            if (!contentValidation.ok) {
              resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
                ...action,
                path: check.normalizedPath,
                status: 'failed',
                message: contentValidation.message,
              }));
              continue;
            }

            const applied = applyAutonomousEditFileWrite(
              repoRoot,
              check.normalizedPath,
              next,
              touchedFiles,
              `Replace action applied successfully using anchor-fragment block matching (${anchorFragmentMatch.anchorCount} anchor lines).`,
            );
            resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
              ...action,
              path: check.normalizedPath,
              status: applied.ok ? 'applied' : 'failed',
              message: applied.message,
            }));
            continue;
          }

          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: buildReplaceFailureDiagnostic(current, find),
          }));
          continue;
        }

        if (matchCount > 1) {
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: `Replace target text matched ${matchCount} times in the file; provide a more specific anchored block.`,
          }));
          continue;
        }

        const next = current.replace(find, replace);
        if (next === current) {
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'skipped',
            message: 'No content change was produced by the replace action.',
          }));
          continue;
        }

        const contentValidation = validateAutonomousEditContent(absolutePath, next);
        if (!contentValidation.ok) {
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'failed',
            message: contentValidation.message,
          }));
          continue;
        }

        const applied = applyAutonomousEditFileWrite(
          repoRoot,
          check.normalizedPath,
          next,
          touchedFiles,
          'Replace action applied successfully.',
        );
        resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
          ...action,
          path: check.normalizedPath,
          status: applied.ok ? 'applied' : 'failed',
          message: applied.message,
        }));
        continue;
      }

      const content = typeof action.content === 'string' ? action.content : '';
      if (!content) {
        resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
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
          resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
            ...action,
            path: check.normalizedPath,
            status: 'skipped',
            message: 'Write action produced no content change.',
          }));
          continue;
        }
      }

      const contentValidation = validateAutonomousEditContent(absolutePath, content);
      if (!contentValidation.ok) {
        resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
          ...action,
          path: check.normalizedPath,
          status: 'failed',
          message: contentValidation.message,
        }));
        continue;
      }

      const applied = applyAutonomousEditFileWrite(
        repoRoot,
        check.normalizedPath,
        content,
        touchedFiles,
        'Write action applied successfully.',
      );
      resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
        ...action,
        path: check.normalizedPath,
        status: applied.ok ? 'applied' : 'failed',
        message: applied.message,
      }));
    } catch (error: any) {
      resultsByIndex.set(index, AppliedAutonomousEditSchema.parse({
        ...action,
        path: check.normalizedPath,
        status: 'failed',
        message: error?.message || String(error),
      }));
    }
  }

  const orderedResults = preflightResults
    .map((entry) => resultsByIndex.get(entry.index))
    .filter((result): result is AppliedAutonomousEdit => Boolean(result));

  return {
    appliedEdits: orderedResults,
    sessionManifest: AutonomousEditSessionManifestSchema.parse({
      ...manifest,
      appliedEdits: orderedResults,
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
