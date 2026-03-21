import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

declare const Bun: any;

function parseWorkerCount(raw: string | undefined): number {
	if (!raw) return 1;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return 1;
	if (normalized === 'auto' || normalized === 'max') {
		return Math.max(1, navigator.hardwareConcurrency || 1);
	}
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed)) return 1;
	return Math.max(1, Math.floor(parsed));
}

// Prefer CLUSTER_WORKERS as the canonical variable; BUN_WORKERS is supported for backward compatibility.
const RAW_WORKER_ENV = process.env.CLUSTER_WORKERS ?? process.env.BUN_WORKERS;
const WORKER_COUNT = parseWorkerCount(RAW_WORKER_ENV);
const RESTART_DELAY_MS = (() => {
	const raw = process.env.BUN_WORKER_RESTART_DELAY_MS;
	const parsed = raw !== undefined ? Number(raw) : 1000;
	const safe = Number.isFinite(parsed) ? parsed : 1000;
	return Math.max(0, safe);
})();
const SHUTDOWN_TIMEOUT_MS = (() => {
	const raw = process.env.SHUTDOWN_TIMEOUT_MS;
	const parsed = raw !== undefined ? Number(raw) : 5000;
	const safe = Number.isFinite(parsed) ? parsed : 5000;
	return Math.max(0, safe);
})();
const PORT_STRIDE = Math.max(0, Number(process.env.CLUSTER_PORT_STRIDE || 0));
const BASE_PORT = Number(process.env.PORT || 3000) || 3000;
const SOURCE_SCRIPT_PATH = fileURLToPath(new URL('./server.bun.ts', import.meta.url));
const SCRIPT_DIR = path.dirname(SOURCE_SCRIPT_PATH);
const DIST_DIR = String(process.env.API_DIST_DIR || '').trim();
const DIST_SERVER_PATH = DIST_DIR ? path.resolve(SCRIPT_DIR, DIST_DIR, 'server.js') : '';
const SCRIPT_PATH = DIST_SERVER_PATH && fs.existsSync(DIST_SERVER_PATH)
  ? DIST_SERVER_PATH
  : SOURCE_SCRIPT_PATH;
const SERVER_MODULE_URL = pathToFileURL(SCRIPT_PATH).href;
const BUN_BIN = process.execPath;
const LAUNCH_LOCK_DIR = path.resolve(SCRIPT_DIR, '.control-plane');
const LAUNCH_LOCK_FILE = path.join(
	LAUNCH_LOCK_DIR,
	`server-launcher.${String(process.env.NODE_ENV || 'development').trim() || 'development'}.${BASE_PORT}.lock.json`,
);

type WorkerProcess = any;

type LaunchLockRecord = {
	pid: number;
	basePort: number;
	nodeEnv: string;
	scriptPath: string;
	acquiredAt: string;
};

const workers = new Map<number, WorkerProcess>();
let shuttingDown = false;

function isPidAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLaunchLock(): LaunchLockRecord | null {
	if (!fs.existsSync(LAUNCH_LOCK_FILE)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(LAUNCH_LOCK_FILE, 'utf8'));
		const pid = Number(parsed?.pid);
		if (!Number.isFinite(pid) || pid <= 0) return null;
		return {
			pid: Math.floor(pid),
			basePort: Number(parsed?.basePort || BASE_PORT) || BASE_PORT,
			nodeEnv: String(parsed?.nodeEnv || process.env.NODE_ENV || '').trim(),
			scriptPath: String(parsed?.scriptPath || SCRIPT_PATH).trim(),
			acquiredAt: String(parsed?.acquiredAt || '').trim(),
		};
	} catch {
		return null;
	}
}

function releaseLaunchLock(): void {
	const existing = readLaunchLock();
	if (!existing || existing.pid !== process.pid) return;
	try {
		fs.rmSync(LAUNCH_LOCK_FILE, { force: true });
	} catch {
		// Ignore lock cleanup failures during shutdown.
	}
}

function acquireLaunchLock(): void {
	fs.mkdirSync(LAUNCH_LOCK_DIR, { recursive: true });
	const record = JSON.stringify({
		pid: process.pid,
		basePort: BASE_PORT,
		nodeEnv: String(process.env.NODE_ENV || '').trim(),
		scriptPath: SCRIPT_PATH,
		acquiredAt: new Date().toISOString(),
	}, null, 2);

	while (true) {
		try {
			const handle = fs.openSync(LAUNCH_LOCK_FILE, 'wx');
			fs.writeFileSync(handle, record, 'utf8');
			fs.closeSync(handle);
			return;
		} catch (error: any) {
			if (error?.code !== 'EEXIST') {
				throw error;
			}
			const existing = readLaunchLock();
			if (!existing || !isPidAlive(existing.pid)) {
				try {
					fs.rmSync(LAUNCH_LOCK_FILE, { force: true });
				} catch {
					// Ignore stale lock cleanup failures; retry create.
				}
				continue;
			}
			console.warn(
				`[Launcher] Another AnyGPT API launcher already owns port ${BASE_PORT} for ${existing.nodeEnv || process.env.NODE_ENV || 'unknown'} (pid ${existing.pid}). Exiting duplicate launcher.`,
			);
			process.exit(75);
		}
	}
}

function buildWorkerEnv(index: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLUSTER_WORKERS: '0',
		BUN_WORKER_MODE: '1',
		BUN_WORKER_INDEX: String(index),
		BUN_WORKER_COUNT: String(WORKER_COUNT),
		SKIP_INITIAL_ADMIN_KEY_CHECK: index === 0 ? (process.env.SKIP_INITIAL_ADMIN_KEY_CHECK || '0') : '1',
		SKIP_ADMIN_KEY_SYNC: index === 0 ? (process.env.SKIP_ADMIN_KEY_SYNC || '0') : '1',
	};

	if (PORT_STRIDE > 0) {
		env.PORT = String(BASE_PORT + (index * PORT_STRIDE));
		env.PORT_RETRY_COUNT = env.PORT_RETRY_COUNT || '0';
		env.BUN_REUSE_PORT = '0';
	} else {
		env.PORT = String(BASE_PORT);
		env.PORT_RETRY_COUNT = '0';
		env.BUN_REUSE_PORT = '1';
	}

	return env;
}

function spawnWorker(index: number): void {
	const env = buildWorkerEnv(index);
	const child = Bun.spawn({
		cmd: [BUN_BIN, 'run', SCRIPT_PATH],
		cwd: SCRIPT_DIR,
		env,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});

	workers.set(index, child);
	console.log(`[Launcher] Spawned Bun worker #${index + 1} (pid ${child.pid}).`);

	child.exited.then((code: number) => {
		workers.delete(index);
		if (shuttingDown) return;
		console.warn(`[Launcher] Bun worker #${index + 1} exited with code ${code}. Respawning...`);
		setTimeout(() => spawnWorker(index), RESTART_DELAY_MS);
	}).catch((error: unknown) => {
		workers.delete(index);
		if (shuttingDown) return;
		console.warn(`[Launcher] Bun worker #${index + 1} failed: ${error}. Respawning...`);
		setTimeout(() => spawnWorker(index), RESTART_DELAY_MS);
	});
}

function shutdown(signal: NodeJS.Signals): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[Launcher] Received ${signal}. Stopping ${workers.size} Bun worker(s)...`);
	for (const child of workers.values()) {
		try {
			child.kill(signal);
		} catch {
			// Ignore shutdown errors.
		}
	}
	setTimeout(() => {
		for (const child of workers.values()) {
			try {
				child.kill('SIGKILL');
			} catch {
				// Ignore hard-stop errors.
			}
		}
		process.exit(0);
	}, SHUTDOWN_TIMEOUT_MS).unref();
}

async function main(): Promise<void> {
	acquireLaunchLock();
	process.on('exit', () => releaseLaunchLock());

	if (WORKER_COUNT <= 1) {
		process.env.CLUSTER_WORKERS = '0';
		await import(SERVER_MODULE_URL);
		return;
	}

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	for (let index = 0; index < WORKER_COUNT; index += 1) {
		spawnWorker(index);
	}

	// Keep the launcher process alive while workers run.
	process.stdin.resume();
}

await main();
