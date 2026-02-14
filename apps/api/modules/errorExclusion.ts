import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.resolve('excluded-errors.json');
const RELOAD_INTERVAL_MS = 30_000;

let patterns: string[] = [];
let lastLoaded = 0;

function loadPatterns(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    patterns = Array.isArray(parsed?.patterns)
      ? parsed.patterns.filter((p: any) => typeof p === 'string' && p.trim().length > 0).map((p: string) => p.toLowerCase())
      : [];
    lastLoaded = Date.now();
  } catch (err: any) {
    if (lastLoaded === 0) {
      console.warn(`[ErrorExclusion] Could not load ${CONFIG_PATH}: ${err.message}. No errors will be excluded.`);
    }
    // Keep existing patterns if reload fails
  }
}

// Initial load
loadPatterns();

/**
 * Returns true if the error message matches any excluded pattern,
 * meaning it should NOT count toward provider disabling.
 */
export function isExcludedError(error: any): boolean {
  // Hot-reload patterns periodically
  if (Date.now() - lastLoaded > RELOAD_INTERVAL_MS) {
    loadPatterns();
  }

  if (patterns.length === 0) return false;

  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return false;

  return patterns.some((pattern) => message.includes(pattern));
}

/**
 * Force-reload patterns from disk (e.g. after editing the file).
 */
export function reloadExcludedErrors(): void {
  loadPatterns();
  console.log(`[ErrorExclusion] Reloaded ${patterns.length} patterns from ${CONFIG_PATH}`);
}
