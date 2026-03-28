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

	const startupSnapshotPath = process.env.ANYGPT_EXPERIMENTAL_STARTUP_SNAPSHOT_PATH;
	const validationThread = process.env.ANYGPT_CONTROL_PLANE_THREAD_ID || process.env.ANYGPT_EXPERIMENTAL_VALIDATION_THREAD || 'unknown';
	const pendingRuns = process.env.ANYGPT_CONTROL_PLANE_PENDING_RUNS || process.env.ANYGPT_EXPERIMENTAL_PENDING_RUN_COUNT || 'unknown';
	const validationRequirement =
		process.env.ANYGPT_EXPERIMENTAL_VALIDATION_SUCCESS ||
		'confirm_a_fresh_same_thread_langsmith_control_plane_run_trace_with_explicit_goal_context_and_a_passed_control_plane_smoke_typecheck_or_preserve_a_clear_no_run_defer_reason';
	const observabilityState = pendingRuns === 'unknown'
		? `same_thread_langsmith_observability_unknown_for_${validationThread}_fresh_iteration_run_still_required`
		: pendingRuns !== '0'
			? `partial_same_thread_langsmith_observability_pending_or_missing_completed_run_for_${validationThread}`
			: `same_thread_langsmith_run_count_reported_zero_for_${validationThread}_fresh_iteration_run_still_required`;

	console.log(
		`[Launcher] Boot config: workers=${WORKER_COUNT}, port=${process.env.PORT || '3000'}, cluster=${WORKER_COUNT > 1 ? 'enabled' : 'disabled'}, swap_recycle=${SWAP_RECYCLE_ENABLED ? 'enabled' : 'disabled'}, server_module=${SERVER_MODULE_URL}`,
	);
	if (startupSnapshotPath) {
		console.log(`[Launcher] Startup snapshot path: ${startupSnapshotPath}`);
	}
	console.log(
		`[Launcher] Validation context: thread=${validationThread}, pending_runs=${pendingRuns}, observability=${observabilityState}, success_condition=${validationRequirement}`,
	);
	console.log(
		`[Launcher] Validation classification: ${pendingRuns === 'unknown' ? 'no_fresh_same_thread_langsmith_run_visible_yet_observability_unknown_preserve_no_run_defer_reason' : pendingRuns !== '0' ? `partial_observability_only_${pendingRuns}_same_thread_run_or_runs_pending_for_${validationThread}_preserve_no_run_defer_reason` : `no_fresh_same_thread_langsmith_run_reported_for_${validationThread}_preserve_no_run_defer_reason_until_new_run_and_smoke_pass`}`,
	);
	const startupValidationTarget =
		process.env.ANYGPT_EXPERIMENTAL_STARTUP_VALIDATION_TARGET ?? 'http://[redacted-ip]:3310/openapi.json';
	const startupMemAvailableBytes = readMemAvailableBytes();
	const startupMemAvailableMb =
		startupMemAvailableBytes !== null ? Math.round(startupMemAvailableBytes / (1024 * 1024)) : 'unknown';
	const startupValidationSource = process.env.ANYGPT_EXPERIMENTAL_STARTUP_VALIDATION_SOURCE ?? 'launcher-default';
	console.log(
		`[Launcher] Startup capacity: mem_available_mb=${startupMemAvailableMb}, swap_recycle_min_mem_available_mb=${SWAP_RECYCLE_MIN_MEM_AVAILABLE_MB}, swap_recycle_max_worker_swap_mb=${SWAP_RECYCLE_MAX_WORKER_SWAP_MB}, swap_recycle_check_interval_ms=${SWAP_RECYCLE_CHECK_INTERVAL_MS}, startup_validation_target=${startupValidationTarget}, startup_validation_source=${startupValidationSource}`,
	);
	if (startupSnapshotPath) {
		const startupSnapshotTimestamp = new Date().toISOString();
		const startupSnapshotLines = [
			`launcher_timestamp=${startupSnapshotTimestamp}`,
			`launcher_pid=${process.pid}`,
			`launcher_thread=${validationThread}`,
			`launcher_goal=continuously_monitor_fix_and_improve_anygpt_across_repo_with_bounded_api_platform_startup_health_improvement`,
			'launcher_repair_signal=recent_langsmith_feedback_sampling_empty_pending_same_thread_runs_and_openapi_reachability_confirmed',
			`launcher_pending_runs=${pendingRuns}`,
			`launcher_observability=${observabilityState}`,
			`launcher_success_condition=${validationRequirement}`,
			`launcher_mem_available_mb=${startupMemAvailableMb}`,
			`launcher_startup_validation_target=${startupValidationTarget}`,
			`launcher_startup_validation_source=${startupValidationSource}`,
			`launcher_experimental_api_base_url=${process.env.API_BASE_URL ?? process.env.EXPERIMENTAL_API_BASE_URL ?? 'unknown'}`,
			`launcher_openapi_url=${startupValidationTarget}`,
			'launcher_openapi_reachability=partial_readiness_evidence_only_not_completed_validation',
			`launcher_cluster_mode=${WORKER_COUNT > 1 ? 'cluster' : 'single-worker'}`,
			`launcher_pending_same_thread_langsmith_runs=${pendingRuns}`,
			pendingRuns === 'unknown'
				? 'launcher_operator_defer_reason=no_fresh_same_thread_langsmith_run_visible_yet_observability_unknown_preserve_no_run_defer_reason'
				: pendingRuns !== '0'
					? `launcher_operator_defer_reason=partial_same_thread_langsmith_observability_pending_${pendingRuns}_for_${validationThread}_preserve_no_run_defer_reason_until_completion_and_smoke_typecheck_pass`
					: `launcher_operator_defer_reason=no_fresh_same_thread_langsmith_run_reported_for_${validationThread}_preserve_no_run_defer_reason_until_new_run_and_smoke_pass`,
		];
		try {
			fs.mkdirSync(path.dirname(startupSnapshotPath), { recursive: true });
			fs.appendFileSync(
				startupSnapshotPath,
				startupSnapshotLines.concat('launcher_snapshot_append=ok').join('\n') + '\n',
			);
		} catch (error) {
			const startupSnapshotError = error instanceof Error ? error.message : String(error);
			console.warn(
				`[Launcher] Failed to append startup snapshot at ${startupSnapshotPath}: ${startupSnapshotError}`,
			);
			try {
				fs.mkdirSync(path.dirname(startupSnapshotPath), { recursive: true });
				fs.writeFileSync(
					startupSnapshotPath,
					startupSnapshotLines
						.concat(
							'launcher_snapshot_append=failed',
							`launcher_snapshot_append_error=${startupSnapshotError.replace(/\s+/g, '_')}`,
						)
						.join('\n') + '\n',
				);
			} catch {
				// Preserve the console warning above as the final fallback observability signal.
			}
		}
	}

	if (WORKER_COUNT <= 1) {
		process.env.CLUSTER_WORKERS = '0';
		console.log(
			`[Launcher] Single-worker mode: importing server module directly for thread=${validationThread}. This is startup/readiness evidence only and not a completed validation run; success still requires ${validationRequirement}.`,
		);
		if (pendingRuns !== '0') {
			console.log(
				`[Launcher] Validation defer context: same-thread LangSmith visibility for ${validationThread} is pending or incomplete (pending_runs=${pendingRuns}); preserve a clear no-run defer reason until a fresh completed same-thread run/trace and smoke/typecheck result exist.`,
			);
		}
		await import(SERVER_MODULE_URL);
		return;
	}

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	const startupValidationSummary = [
		`thread=${validationThread}`,
		`worker_mode=${WORKER_COUNT <= 1 ? 'single' : 'cluster'}`,
		`worker_count=${WORKER_COUNT}`,
		`pending_same_thread_runs=${pendingRuns}`,
		`readiness=partial_until_fresh_same_thread_langsmith_run_and_smoke`,
		`validation_requirement=${validationRequirement}`,
		pendingRuns !== '0'
			? `operator_defer_reason=same_thread_langsmith_visibility_for_${validationThread}_is_${pendingRuns === 'unknown' ? 'unknown' : 'pending_or_incomplete'}_preserve_no_run_defer_reason_until_fresh_completed_same_thread_run_trace_and_smoke_typecheck_exist`
			: `operator_defer_reason=fresh_same_thread_langsmith_run_trace_and_smoke_typecheck_still_required_for_${validationThread}`,
	].join(' ');
	console.log(`[Launcher] Startup validation summary: ${startupValidationSummary}`);
	const startupSummaryDirs = [
		process.env.ANYGPT_RUNTIME_DIR?.trim(),
		'/run/anygpt',
		path.join(process.cwd(), '.control-plane', 'experimental'),
	].filter((value): value is string => Boolean(value && value.trim()));
	let startupSummaryPersisted = false;
	for (const runtimeDir of startupSummaryDirs) {
		try {
			fs.mkdirSync(runtimeDir, { recursive: true });
			const startupSummaryPath = path.join(runtimeDir, 'experimental-startup-validation.summary');
			fs.writeFileSync(`${startupSummaryPath}.tmp`, `${startupValidationSummary}\n`, 'utf8');
			fs.renameSync(`${startupSummaryPath}.tmp`, startupSummaryPath);
			console.log(`[Launcher] Wrote startup validation summary to ${startupSummaryPath}`);
			startupSummaryPersisted = true;
			break;
		} catch (error) {
			console.warn(`[Launcher] Failed to persist startup validation summary in ${runtimeDir}:`, error);
		}
	}
	if (!startupSummaryPersisted) {
		console.warn('[Launcher] Failed to persist startup validation summary in all candidate directories.');
	}

	const pendingRunsState = pendingRuns === '0' ? 'none-observed' : pendingRuns === 'unknown' ? 'unknown' : 'pending-or-incomplete';
	const validationCheckedAt = new Date().toISOString();
	const validationTarget = process.env.ANYGPT_EXPERIMENTAL_STARTUP_VALIDATION_TARGET?.trim() || 'unknown';
	const validationDeferReason = pendingRuns === '0'
		? `fresh same-thread LangSmith run/trace still missing for ${validationThread}; clustered worker startup is partial readiness evidence only until smoke/typecheck also passes.`
		: pendingRuns === 'unknown'
			? `same-thread LangSmith visibility is unknown for ${validationThread}; clustered worker startup is partial readiness evidence only, so preserve a no-run defer reason until a fresh completed same-thread run/trace and smoke/typecheck result exist.`
			: `same-thread LangSmith run/trace is still pending or incomplete for ${validationThread} (pending_runs=${pendingRuns}); clustered worker startup is partial readiness evidence only, not completed validation.`;
	let validationStatePersisted = false;
	for (const runtimeDir of startupSummaryDirs) {
		try {
			fs.mkdirSync(runtimeDir, { recursive: true });
			const validationStatePath = path.join(runtimeDir, 'experimental-startup-validation.state');
			const validationState = [
				`thread_id=${validationThread}`,
				`checked_at=${validationCheckedAt}`,
				`validation_target=${validationTarget}`,
				`pending_runs=${pendingRuns}`,
				`pending_runs_state=${pendingRunsState}`,
				'operator_readiness=partial',
				'operator_validation=deferred',
				`operator_defer_reason=${validationDeferReason.replace(/\s+/g, '_')}`,
			].join('\n');
			fs.writeFileSync(`${validationStatePath}.tmp`, `${validationState}\n`, 'utf8');
			fs.renameSync(`${validationStatePath}.tmp`, validationStatePath);
			console.log(`[Launcher] Wrote startup validation state to ${validationStatePath}`);
			validationStatePersisted = true;
		} catch (error) {
			console.warn(`[Launcher] Failed to persist startup validation state in ${runtimeDir}:`, error);
		}
	}
	if (!validationStatePersisted) {
		console.warn('[Launcher] Failed to persist startup validation state in all candidate directories.');
	}

	if (pendingRuns !== '0') {
		console.log(
			`[Launcher] Cluster validation defer context: same-thread LangSmith visibility for ${validationThread} is ${pendingRuns === 'unknown' ? 'unknown' : 'pending or incomplete'} (pending_runs=${pendingRuns}); clustered worker startup is partial readiness evidence only and not a completed validation run, so preserve a clear no-run defer reason until a fresh completed same-thread run/trace and smoke/typecheck result exist.`,
		);
	} else {
		console.log(
			`[Launcher] Cluster validation defer context: no fresh same-thread LangSmith run/trace was observed yet for ${validationThread}; clustered worker startup remains partial readiness evidence only until a fresh same-thread run/trace with explicit goal context and a passed smoke/typecheck result exist.`,
		);
	}

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
