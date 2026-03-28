import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

declare const Bun: any;

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, min: number = 0): number {
	const parsed = raw !== undefined ? Number(raw) : fallback;
	const safe = Number.isFinite(parsed) ? parsed : fallback;
	return Math.max(min, Math.floor(safe));
}

function parseBytesFromMeminfoLine(rawLine: string | undefined): number | null {
	if (!rawLine) return null;
	const match = rawLine.match(/:\s*(\d+)\s*kB/i);
	if (!match) return null;
	const kilobytes = Number(match[1]);
	return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

function readMemAvailableBytes(): number | null {
	try {
		const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
		const line = meminfo
			.split('\n')
			.find((entry) => entry.startsWith('MemAvailable:'));
		return parseBytesFromMeminfoLine(line);
	} catch {
		return null;
	}
}

function readWorkerStatusBytes(pid: number, key: 'VmSwap' | 'VmRSS'): number | null {
	if (!Number.isFinite(pid) || pid <= 0) return null;
	try {
		const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
		const line = status
			.split('\n')
			.find((entry) => entry.startsWith(`${key}:`));
		return parseBytesFromMeminfoLine(line);
	} catch {
		return null;
	}
}

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
const SERVER_SHUTDOWN_GRACE_MS = (() => {
	const raw = process.env.SHUTDOWN_GRACE_MS;
	const parsed = raw !== undefined ? Number(raw) : 15_000;
	const safe = Number.isFinite(parsed) ? parsed : 15_000;
	return Math.max(1_000, safe);
})();
const SHUTDOWN_TIMEOUT_MS = (() => {
	const raw = process.env.SHUTDOWN_TIMEOUT_MS;
	const fallback = SERVER_SHUTDOWN_GRACE_MS + 5_000;
	const parsed = raw !== undefined ? Number(raw) : fallback;
	const safe = Number.isFinite(parsed) ? parsed : fallback;
	return Math.max(SERVER_SHUTDOWN_GRACE_MS, safe);
})();
const SWAP_RECYCLE_ENABLED = parseBooleanEnv(
	process.env.CLUSTER_SWAP_RECYCLE_ENABLED,
	WORKER_COUNT > 1,
);
const SWAP_RECYCLE_CHECK_INTERVAL_MS = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_CHECK_INTERVAL_MS,
	60_000,
	10_000,
);
const SWAP_RECYCLE_MIN_AGE_MS = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_MIN_AGE_MS,
	15 * 60_000,
	60_000,
);
const SWAP_RECYCLE_COOLDOWN_MS = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_COOLDOWN_MS,
	5 * 60_000,
	30_000,
);
const SWAP_RECYCLE_TERM_GRACE_MS = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_TERM_GRACE_MS,
	Math.min(SERVER_SHUTDOWN_GRACE_MS, 15_000),
	1_000,
);
const SWAP_RECYCLE_MIN_MEM_AVAILABLE_MB = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_MIN_MEM_AVAILABLE_MB,
	8 * 1024,
	512,
);
const SWAP_RECYCLE_MAX_WORKER_SWAP_MB = parseNonNegativeInteger(
	process.env.CLUSTER_SWAP_RECYCLE_MAX_WORKER_SWAP_MB,
	4 * 1024,
	256,
);
const SWAP_RECYCLE_MIN_MEM_AVAILABLE_BYTES = SWAP_RECYCLE_MIN_MEM_AVAILABLE_MB * 1024 * 1024;
const SWAP_RECYCLE_MAX_WORKER_SWAP_BYTES = SWAP_RECYCLE_MAX_WORKER_SWAP_MB * 1024 * 1024;
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
const configuredRuntimeDir = String(
	process.env.ANYGPT_RUNTIME_DIR || process.env.ANYGPT_LAUNCH_LOCK_DIR || ''
).trim();
const LAUNCH_LOCK_DIR = configuredRuntimeDir
	? path.resolve(configuredRuntimeDir)
	: path.resolve(SCRIPT_DIR, '.control-plane');
const LAUNCH_LOCK_FILE = path.join(
	LAUNCH_LOCK_DIR,
	`server-launcher.${String(process.env.NODE_ENV || 'development').trim() || 'development'}.${BASE_PORT}.lock.json`,
);

type WorkerProcess = any;
type WorkerMemorySnapshot = {
	index: number;
	pid: number;
	rssBytes: number;
	swapBytes: number;
	ageMs: number;
};

type LaunchLockRecord = {
	pid: number;
	basePort: number;
	nodeEnv: string;
	scriptPath: string;
	acquiredAt: string;
};

const workers = new Map<number, WorkerProcess>();
const workerSpawnedAtMs = new Map<number, number>();
const workerRecycleTimers = new Map<number, NodeJS.Timeout>();
const workerRecycleReasons = new Map<number, string>();
let shuttingDown = false;
let lastWorkerRecycleAt = 0;

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
	workerSpawnedAtMs.set(index, Date.now());
	console.log(`[Launcher] Spawned Bun worker #${index + 1} (pid ${child.pid}).`);

	child.exited.then((code: number) => {
		workers.delete(index);
		workerSpawnedAtMs.delete(index);
		const recycleTimer = workerRecycleTimers.get(index);
		if (recycleTimer) {
			clearTimeout(recycleTimer);
			workerRecycleTimers.delete(index);
		}
		workerRecycleReasons.delete(index);
		if (shuttingDown) return;
		console.warn(`[Launcher] Bun worker #${index + 1} exited with code ${code}. Respawning...`);
		setTimeout(() => spawnWorker(index), RESTART_DELAY_MS);
	}).catch((error: unknown) => {
		workers.delete(index);
		workerSpawnedAtMs.delete(index);
		const recycleTimer = workerRecycleTimers.get(index);
		if (recycleTimer) {
			clearTimeout(recycleTimer);
			workerRecycleTimers.delete(index);
		}
		workerRecycleReasons.delete(index);
		if (shuttingDown) return;
		console.warn(`[Launcher] Bun worker #${index + 1} failed: ${error}. Respawning...`);
		setTimeout(() => spawnWorker(index), RESTART_DELAY_MS);
	});
}

function collectWorkerMemorySnapshots(): WorkerMemorySnapshot[] {
	const now = Date.now();
	const snapshots: WorkerMemorySnapshot[] = [];

	for (const [index, child] of workers.entries()) {
		const pid = Number(child?.pid || 0);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		const rssBytes = readWorkerStatusBytes(pid, 'VmRSS') ?? 0;
		const swapBytes = readWorkerStatusBytes(pid, 'VmSwap') ?? 0;
		const spawnedAtMs = workerSpawnedAtMs.get(index) ?? now;
		snapshots.push({
			index,
			pid,
			rssBytes,
			swapBytes,
			ageMs: Math.max(0, now - spawnedAtMs),
		});
	}

	return snapshots;
}

function requestWorkerRecycle(snapshot: WorkerMemorySnapshot, memAvailableBytes: number): void {
	if (workerRecycleReasons.has(snapshot.index)) return;
	const child = workers.get(snapshot.index);
	if (!child) return;

	const reason = `swap=${(snapshot.swapBytes / (1024 * 1024)).toFixed(0)}MB with mem_available=${(memAvailableBytes / (1024 * 1024)).toFixed(0)}MB after ${(snapshot.ageMs / 60_000).toFixed(1)}m`;
	workerRecycleReasons.set(snapshot.index, reason);
	lastWorkerRecycleAt = Date.now();
	console.warn(
		`[Launcher] Recycling Bun worker #${snapshot.index + 1} (pid ${snapshot.pid}) to reclaim stale swap (${reason}).`,
	);
	try {
		child.kill('SIGTERM');
	} catch {
		workerRecycleReasons.delete(snapshot.index);
		return;
	}

	const timer = setTimeout(() => {
		const liveChild = workers.get(snapshot.index);
		if (!liveChild) return;
		if (Number(liveChild?.pid || 0) !== snapshot.pid) return;
		console.warn(
			`[Launcher] Bun worker #${snapshot.index + 1} (pid ${snapshot.pid}) did not exit after swap recycle request; sending SIGKILL.`,
		);
		try {
			liveChild.kill('SIGKILL');
		} catch {
			// Ignore forced recycle failures; normal exit handling will clear the state if the process exits.
		}
	}, SWAP_RECYCLE_TERM_GRACE_MS);
	timer.unref();
	workerRecycleTimers.set(snapshot.index, timer);
}

function maybeRecycleSwappedWorker(): void {
	if (!SWAP_RECYCLE_ENABLED || shuttingDown) return;
	if (workers.size <= 1) return;
	if (Date.now() - lastWorkerRecycleAt < SWAP_RECYCLE_COOLDOWN_MS) return;

	const memAvailableBytes = readMemAvailableBytes();
	if (memAvailableBytes === null || memAvailableBytes < SWAP_RECYCLE_MIN_MEM_AVAILABLE_BYTES) return;

	const candidate = collectWorkerMemorySnapshots()
		.filter((snapshot) => snapshot.swapBytes >= SWAP_RECYCLE_MAX_WORKER_SWAP_BYTES)
		.filter((snapshot) => snapshot.ageMs >= SWAP_RECYCLE_MIN_AGE_MS)
		.filter((snapshot) => !workerRecycleReasons.has(snapshot.index))
		.sort((left, right) => right.swapBytes - left.swapBytes)[0];

	if (!candidate) return;
	requestWorkerRecycle(candidate, memAvailableBytes);
}

function shutdown(signal: NodeJS.Signals): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[Launcher] Received ${signal}. Stopping ${workers.size} Bun worker(s)...`);
	for (const timer of workerRecycleTimers.values()) {
		clearTimeout(timer);
	}
	workerRecycleTimers.clear();
	workerRecycleReasons.clear();
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

	if (SWAP_RECYCLE_ENABLED) {
		console.log(
			`[Launcher] Swap recycle watchdog enabled (worker_swap_mb>=${SWAP_RECYCLE_MAX_WORKER_SWAP_MB}, mem_available_mb>=${SWAP_RECYCLE_MIN_MEM_AVAILABLE_MB}, min_age_ms=${SWAP_RECYCLE_MIN_AGE_MS}).`,
		);
		const interval = setInterval(() => maybeRecycleSwappedWorker(), SWAP_RECYCLE_CHECK_INTERVAL_MS);
		interval.unref();
	}

	// Keep the launcher process alive while workers run.
	process.stdin.resume();
}

await main();
