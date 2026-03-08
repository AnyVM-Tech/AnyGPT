export {};

function parseWorkerCount(raw: string | undefined): number {
  if (!raw) return 0;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized === 'auto' || normalized === 'max') return 2;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

const requestedWorkers = parseWorkerCount(process.env.CLUSTER_WORKERS ?? process.env.BUN_WORKERS);
const isBunWorker = process.env.BUN_WORKER_MODE === '1';
const launcherModuleUrl = new URL('./server.launcher.bun.ts', import.meta.url).href;
const serverModuleUrl = new URL('./server.ts', import.meta.url).href;

if (!isBunWorker && requestedWorkers > 1) {
  await import(launcherModuleUrl);
} else {
  process.env.CLUSTER_WORKERS = '0';
  await import(serverModuleUrl);
}
