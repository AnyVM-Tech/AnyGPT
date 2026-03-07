import { fileURLToPath } from 'node:url';
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
const SCRIPT_PATH = fileURLToPath(new URL('./server.bun.ts', import.meta.url));
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const BUN_BIN = process.execPath;

type WorkerProcess = any;

const workers = new Map<number, WorkerProcess>();
let shuttingDown = false;

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
	if (WORKER_COUNT <= 1) {
		process.env.CLUSTER_WORKERS = '0';
		await import('./server.bun.js');
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
