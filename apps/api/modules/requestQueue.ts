import fs from 'node:fs';
import os from 'node:os';
import tiersData from '../tiers.json' with { type: 'json' };

export type RequestQueueSnapshot = {
	label: string;
	concurrency: number;
	maxPending: number;
	maxWaitMs: number;
	inFlight: number;
	pending: number;
	overloadCount: number;
	lastOverloadedAt?: string;
};

export type MemoryPressureSnapshot = {
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	systemTotalBytes: number;
	systemFreeBytes: number;
	systemAvailableBytes: number;
	swapTotalBytes: number | null;
	swapFreeBytes: number | null;
	swapUsedBytes: number | null;
};

export class QueueOverloadedError extends Error {
	readonly code = 'QUEUE_OVERLOADED';
	readonly statusCode = 503;
	readonly queueLabel?: string;
	readonly concurrency?: number;
	readonly maxPending?: number;
	readonly maxWaitMs?: number;
	readonly inFlight?: number;
	readonly pending?: number;
	readonly overloadCount?: number;
	readonly lastOverloadedAt?: string;

	constructor(
		message: string = 'Service temporarily unavailable: request queue is busy. Retry in a few seconds.',
		snapshot?: RequestQueueSnapshot
	) {
		super(message);
		this.name = 'QueueOverloadedError';
		if (snapshot) {
			this.queueLabel = snapshot.label;
			this.concurrency = snapshot.concurrency;
			this.maxPending = snapshot.maxPending;
			this.maxWaitMs = snapshot.maxWaitMs;
			this.inFlight = snapshot.inFlight;
			this.pending = snapshot.pending;
			this.overloadCount = snapshot.overloadCount;
			this.lastOverloadedAt = snapshot.lastOverloadedAt;
		}
	}
}

export class QueueWaitTimeoutError extends Error {
	readonly code = 'QUEUE_WAIT_TIMEOUT';
	readonly statusCode = 503;
	readonly queueLabel?: string;
	readonly concurrency?: number;
	readonly maxPending?: number;
	readonly maxWaitMs?: number;
	readonly inFlight?: number;
	readonly pending?: number;
	readonly overloadCount?: number;
	readonly lastOverloadedAt?: string;

	constructor(
		message: string = 'Service temporarily unavailable: request queue wait timed out. Retry in a few seconds.',
		snapshot?: RequestQueueSnapshot
	) {
		super(message);
		this.name = 'QueueWaitTimeoutError';
		if (snapshot) {
			this.queueLabel = snapshot.label;
			this.concurrency = snapshot.concurrency;
			this.maxPending = snapshot.maxPending;
			this.maxWaitMs = snapshot.maxWaitMs;
			this.inFlight = snapshot.inFlight;
			this.pending = snapshot.pending;
			this.overloadCount = snapshot.overloadCount;
			this.lastOverloadedAt = snapshot.lastOverloadedAt;
		}
	}
}

export class MemoryPressureError extends Error {
	readonly code = 'MEMORY_PRESSURE';
	readonly statusCode = 503;
	readonly label: string;
	readonly reasons: string[];
	readonly snapshot: MemoryPressureSnapshot;
	readonly contentLengthBytes?: number | null;

	constructor(
		label: string,
		reasons: string[],
		snapshot: MemoryPressureSnapshot,
		contentLengthBytes?: number | null
	) {
		const contentLengthMb =
			Number.isFinite(contentLengthBytes as number) &&
			(contentLengthBytes as number) > 0
				? ` content_length_mb=${bytesToMegabytes(contentLengthBytes as number).toFixed(1)}`
				: '';
		super(
			`Service temporarily unavailable: ${label} rejected under memory pressure (${reasons.join('; ')}).${contentLengthMb}`
		);
		this.name = 'MemoryPressureError';
		this.label = label;
		this.reasons = reasons;
		this.snapshot = snapshot;
		this.contentLengthBytes = contentLengthBytes;
	}
}

type RequestQueueOptions = {
	maxPending?: number;
	maxWaitMs?: number;
	label?: string;
	memoryPressureGuard?: boolean;
};

export type RequestQueueLane = 'shared' | 'responses';

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_SYSTEM_TOTAL_MB = Math.max(
	1,
	Math.floor(os.totalmem() / BYTES_PER_MEGABYTE)
);
const MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB = (() => {
	const fallback = Math.max(
		768,
		Math.min(3072, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.08))
	);
	const raw = Number(
		process.env.REQUEST_MEMORY_MIN_AVAILABLE_SYSTEM_MB ?? fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_SWAP_USED_MB = (() => {
	const fallback = Math.max(
		4096,
		Math.min(16384, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.5))
	);
	const raw = Number(process.env.REQUEST_MEMORY_MAX_SWAP_USED_MB ?? fallback);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_RSS_MB = (() => {
	const fallback = Math.max(
		1536,
		Math.min(4096, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.25))
	);
	const raw = Number(process.env.REQUEST_MEMORY_MAX_RSS_MB ?? fallback);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE = (() => {
	const fallback = Math.max(
		384,
		Math.min(1024, Math.floor(MEMORY_PRESSURE_MAX_RSS_MB * 0.25))
	);
	const raw = Number(
		process.env.REQUEST_MEMORY_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE ??
			fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_SWAP_GATE = (() => {
	const fallback = Math.max(
		MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE,
		Math.floor(MEMORY_PRESSURE_MAX_RSS_MB * 0.5)
	);
	const raw = Number(
		process.env.REQUEST_MEMORY_MIN_ACTIVE_RUNTIME_MB_FOR_SWAP_GATE ??
			fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MIN_RSS_MB_FOR_SWAP_GATE = (() => {
	const fallback = Math.max(
		MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE,
		Math.floor(MEMORY_PRESSURE_MAX_RSS_MB * 0.9)
	);
	const raw = Number(
		process.env.REQUEST_MEMORY_MIN_RSS_MB_FOR_SWAP_GATE ?? fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_EXTERNAL_MB = (() => {
	const fallback = Math.max(
		256,
		Math.min(1024, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.08))
	);
	const raw = Number(process.env.REQUEST_MEMORY_MAX_EXTERNAL_MB ?? fallback);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB = (() => {
	const fallback = Math.max(
		128,
		Math.min(768, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.05))
	);
	const raw = Number(
		process.env.REQUEST_MEMORY_MAX_ARRAY_BUFFERS_MB ?? fallback
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_LOG_COOLDOWN_MS = (() => {
	const raw = Number(
		process.env.REQUEST_MEMORY_PRESSURE_LOG_COOLDOWN_MS ?? 10_000
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000;
})();
const MEMORY_PRESSURE_SMALL_BODY_BYPASS_BYTES = (() => {
	const raw = Number(
		process.env.REQUEST_MEMORY_SMALL_BODY_BYPASS_BYTES ?? 256 * 1024
	);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 256 * 1024;
})();

let lastMemoryPressureLogAt = 0;
let cachedProcMeminfoReadAt = 0;
let cachedProcMeminfo: {
	memAvailableBytes?: number;
	swapTotalBytes?: number;
	swapFreeBytes?: number;
} | null = null;

function bytesToMegabytes(bytes: number): number {
	return bytes / BYTES_PER_MEGABYTE;
}

function readProcMeminfo(): {
	memAvailableBytes?: number;
	swapTotalBytes?: number;
	swapFreeBytes?: number;
} {
	const now = Date.now();
	if (cachedProcMeminfo && now - cachedProcMeminfoReadAt < 500) {
		return cachedProcMeminfo;
	}

	try {
		const raw = fs.readFileSync('/proc/meminfo', 'utf8');
		const values: Record<string, number> = {};
		for (const line of raw.split('\n')) {
			const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
			if (!match) continue;
			values[match[1]] = Number(match[2]) * 1024;
		}
		cachedProcMeminfoReadAt = now;
		cachedProcMeminfo = {
			memAvailableBytes: values.MemAvailable,
			swapTotalBytes: values.SwapTotal,
			swapFreeBytes: values.SwapFree
		};
		return cachedProcMeminfo;
	} catch {
		cachedProcMeminfoReadAt = now;
		cachedProcMeminfo = {};
		return cachedProcMeminfo;
	}
}

export function getMemoryPressureSnapshot(): MemoryPressureSnapshot {
	const usage = process.memoryUsage();
	const procMeminfo = readProcMeminfo();
	const systemTotalBytes = os.totalmem();
	const systemFreeBytes = os.freemem();
	const systemAvailableBytes =
		procMeminfo.memAvailableBytes ?? systemFreeBytes;
	const swapTotalBytes =
		typeof procMeminfo.swapTotalBytes === 'number'
			? procMeminfo.swapTotalBytes
			: null;
	const swapFreeBytes =
		typeof procMeminfo.swapFreeBytes === 'number'
			? procMeminfo.swapFreeBytes
			: null;
	const swapUsedBytes =
		swapTotalBytes !== null && swapFreeBytes !== null
			? Math.max(0, swapTotalBytes - swapFreeBytes)
			: null;
	return {
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		heapTotalBytes: usage.heapTotal,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers,
		systemTotalBytes,
		systemFreeBytes,
		systemAvailableBytes,
		swapTotalBytes,
		swapFreeBytes,
		swapUsedBytes
	};
}

function buildMemoryPressureReasons(
	snapshot: MemoryPressureSnapshot
): string[] {
	const reasons: string[] = [];
	const availableSystemMb = bytesToMegabytes(snapshot.systemAvailableBytes);
	const swapUsedMb =
		snapshot.swapUsedBytes !== null
			? bytesToMegabytes(snapshot.swapUsedBytes)
			: null;
	const rssMb = bytesToMegabytes(snapshot.rssBytes);
	const heapUsedMb = bytesToMegabytes(snapshot.heapUsedBytes);
	const externalMb = bytesToMegabytes(snapshot.externalBytes);
	const arrayBuffersMb = bytesToMegabytes(snapshot.arrayBuffersBytes);
	const activeRuntimeMb = heapUsedMb + externalMb + arrayBuffersMb;
	const rssNearSwapGate = rssMb >= MEMORY_PRESSURE_MIN_RSS_MB_FOR_SWAP_GATE;
	const actionableSwapPressure =
		swapUsedMb !== null &&
		swapUsedMb >= MEMORY_PRESSURE_MAX_SWAP_USED_MB &&
		(
			availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB * 2 ||
			(
				rssNearSwapGate &&
				activeRuntimeMb >=
					MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_SWAP_GATE
			)
		);
	const elevatedSwapPressure =
		swapUsedMb !== null &&
		swapUsedMb >= Math.floor(MEMORY_PRESSURE_MAX_SWAP_USED_MB * 0.5) &&
		(
			availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB * 2 ||
			(
				rssNearSwapGate &&
				activeRuntimeMb >=
					MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_SWAP_GATE
			)
		);

	if (availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB) {
		reasons.push(
			`available_system_mb=${availableSystemMb.toFixed(0)}<=${MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB}`
		);
	}
	if (actionableSwapPressure) {
		reasons.push(
			`swap_used_mb=${swapUsedMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_SWAP_USED_MB}`
		);
	}

	const lowHeadroom =
		availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB * 2
		|| elevatedSwapPressure;
	const lowHeadroomForBufferPressure =
		availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB * 2
		|| rssMb >= MEMORY_PRESSURE_MAX_RSS_MB;
	if (
		lowHeadroom &&
		rssMb >= MEMORY_PRESSURE_MAX_RSS_MB &&
		activeRuntimeMb >= MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE
	) {
		reasons.push(
			`rss_mb=${rssMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_RSS_MB}` +
				` active_runtime_mb=${activeRuntimeMb.toFixed(0)}>=${MEMORY_PRESSURE_MIN_ACTIVE_RUNTIME_MB_FOR_RSS_GATE}`
		);
	}
	if (
		lowHeadroomForBufferPressure &&
		externalMb >= MEMORY_PRESSURE_MAX_EXTERNAL_MB
	) {
		reasons.push(
			`external_mb=${externalMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_EXTERNAL_MB}`
		);
	}
	if (
		lowHeadroomForBufferPressure &&
		arrayBuffersMb >= MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB
	) {
		reasons.push(
			`array_buffers_mb=${arrayBuffersMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB}`
		);
	}

	return reasons;
}

function logMemoryPressure(
	label: string,
	reasons: string[],
	snapshot: MemoryPressureSnapshot,
	contentLengthBytes?: number | null
): void {
	const now = Date.now();
	if (now - lastMemoryPressureLogAt < MEMORY_PRESSURE_LOG_COOLDOWN_MS) return;
	lastMemoryPressureLogAt = now;

	const details = {
		label,
		reasons,
		contentLengthBytes: Number.isFinite(contentLengthBytes as number)
			? Math.max(0, Number(contentLengthBytes))
			: undefined,
		rssMb: Number(bytesToMegabytes(snapshot.rssBytes).toFixed(1)),
		heapUsedMb: Number(bytesToMegabytes(snapshot.heapUsedBytes).toFixed(1)),
		externalMb: Number(bytesToMegabytes(snapshot.externalBytes).toFixed(1)),
		arrayBuffersMb: Number(
			bytesToMegabytes(snapshot.arrayBuffersBytes).toFixed(1)
		),
		availableSystemMb: Number(
			bytesToMegabytes(snapshot.systemAvailableBytes).toFixed(1)
		),
		swapUsedMb:
			snapshot.swapUsedBytes !== null
				? Number(bytesToMegabytes(snapshot.swapUsedBytes).toFixed(1))
				: null
	};
	console.warn(`[MemoryPressure] ${JSON.stringify(details)}`);
}

function isSmallBodyBypassEligible(
	label: string,
	reasons: string[],
	snapshot: MemoryPressureSnapshot,
	contentLengthBytes?: number | null
): boolean {
	if (
		!Number.isFinite(contentLengthBytes as number) ||
		(contentLengthBytes as number) <= 0
	)
		return false;
	if (
		(contentLengthBytes as number) > MEMORY_PRESSURE_SMALL_BODY_BYPASS_BYTES
	)
		return false;

	const normalizedLabel = String(label || '').toLowerCase();
	if (
		!normalizedLabel.includes('intake') &&
		normalizedLabel !== 'request-body-read'
	)
		return false;

	const availableSystemMb = bytesToMegabytes(snapshot.systemAvailableBytes);
	const swapUsedMb =
		snapshot.swapUsedBytes !== null
			? bytesToMegabytes(snapshot.swapUsedBytes)
			: null;
	const severeSystemPressure =
		availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB ||
		(swapUsedMb !== null && swapUsedMb >= MEMORY_PRESSURE_MAX_SWAP_USED_MB);
	if (severeSystemPressure) return false;

	return reasons.every(
		reason =>
			reason.startsWith('rss_mb=') ||
			reason.startsWith('external_mb=') ||
			reason.startsWith('array_buffers_mb=')
	);
}

export function isMemoryPressureError(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		(error as any).code === 'MEMORY_PRESSURE'
	);
}

export function parseContentLengthHeader(value: unknown): number | null {
	const raw =
		typeof value === 'string'
			? value
			: Array.isArray(value) && value.length > 0
				? String(value[0])
				: '';
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return Math.floor(parsed);
}

export function rejectOnMemoryPressure(
	label: string,
	contentLengthBytes?: number | null
): void {
	const snapshot = getMemoryPressureSnapshot();
	const reasons = buildMemoryPressureReasons(snapshot);
	if (reasons.length === 0) return;
	if (
		isSmallBodyBypassEligible(label, reasons, snapshot, contentLengthBytes)
	) {
		return;
	}
	logMemoryPressure(label, reasons, snapshot, contentLengthBytes);
	throw new MemoryPressureError(label, reasons, snapshot, contentLengthBytes);
}

export class RequestQueue {
	private readonly concurrency: number;
	private readonly maxPendingLimit: number;
	private readonly maxWaitMs: number;
	private readonly label: string;
	private readonly memoryPressureGuard: boolean;
	private running = 0;
	private readonly queue: Array<() => void> = [];
	private overloadCount = 0;
	private lastOverloadedAt = 0;

	constructor(concurrency: number, options: RequestQueueOptions = {}) {
		this.concurrency = Math.max(1, Math.floor(concurrency || 1));
		this.label =
			String(options.label || 'request-queue').trim() || 'request-queue';
		const suggestedMaxPending = Math.max(16, this.concurrency * 8);
		const rawMaxPending = Number(options.maxPending ?? suggestedMaxPending);
		this.maxPendingLimit =
			Number.isFinite(rawMaxPending) && rawMaxPending >= 0
				? Math.floor(rawMaxPending)
				: suggestedMaxPending;
		const rawMaxWaitMs = Number(options.maxWaitMs ?? 0);
		this.maxWaitMs =
			Number.isFinite(rawMaxWaitMs) && rawMaxWaitMs > 0
				? Math.floor(rawMaxWaitMs)
				: 0;
		this.memoryPressureGuard = options.memoryPressureGuard === true;
	}

	get pending(): number {
		return this.queue.length;
	}

	get inFlight(): number {
		return this.running;
	}

	snapshot(): RequestQueueSnapshot {
		return {
			label: this.label,
			concurrency: this.concurrency,
			maxPending: this.maxPendingLimit,
			maxWaitMs: this.maxWaitMs,
			inFlight: this.running,
			pending: this.queue.length,
			overloadCount: this.overloadCount,
			lastOverloadedAt:
				this.lastOverloadedAt > 0
					? new Date(this.lastOverloadedAt).toISOString()
					: undefined
		};
	}

	async acquire(): Promise<() => void> {
		if (this.memoryPressureGuard) {
			rejectOnMemoryPressure(this.label);
		}

		if (this.running < this.concurrency) {
			this.running += 1;
			return () => this.release();
		}

		if (this.queue.length >= this.maxPendingLimit) {
			this.overloadCount += 1;
			this.lastOverloadedAt = Date.now();
			const snapshot = this.snapshot();
			throw new QueueOverloadedError(
				`Service temporarily unavailable: request queue ${snapshot.label} is busy (concurrency=${snapshot.concurrency}, in_flight=${snapshot.inFlight}, pending=${snapshot.pending}, max_pending=${snapshot.maxPending}, overload_count=${snapshot.overloadCount}). Retry in a few seconds.`,
				snapshot
			);
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			let timeoutId: NodeJS.Timeout | null = null;
			const queueEntry = () => {
				if (settled) return;
				if (this.memoryPressureGuard) {
					try {
						rejectOnMemoryPressure(this.label);
					} catch (error) {
						settled = true;
						if (timeoutId) clearTimeout(timeoutId);
						reject(error);
						return;
					}
				}
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				this.running += 1;
				resolve(() => this.release());
			};

			this.queue.push(queueEntry);

			if (this.maxWaitMs > 0) {
				timeoutId = setTimeout(() => {
					if (settled) return;
					settled = true;
					const queueIndex = this.queue.indexOf(queueEntry);
					if (queueIndex !== -1) {
						this.queue.splice(queueIndex, 1);
					}
					const snapshot = this.snapshot();
					reject(
						new QueueWaitTimeoutError(
							`Service temporarily unavailable: request queue ${snapshot.label} waited too long (wait_ms=${snapshot.maxWaitMs}, concurrency=${snapshot.concurrency}, in_flight=${snapshot.inFlight}, pending=${snapshot.pending}, max_pending=${snapshot.maxPending}, overload_count=${snapshot.overloadCount}). Retry in a few seconds.`,
							snapshot
						)
					);
				}, this.maxWaitMs);
			}
		});
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private release(): void {
		this.running = Math.max(0, this.running - 1);
		const next = this.queue.shift();
		if (next) next();
	}
}

function getBaselineTierRps(): number {
	const values = Object.values(tiersData as Record<string, any>)
		.map(tier => Number(tier?.rps))
		.filter(value => Number.isFinite(value) && value > 0);
	if (values.length === 0) return 20;
	return Math.floor(Math.min(...values));
}

let cachedSystemMemoryBytes: number | null = null;
let cachedCpuCount: number | null = null;
function getSystemMemoryBytes(): number {
	if (cachedSystemMemoryBytes !== null) return cachedSystemMemoryBytes;
	try {
		cachedSystemMemoryBytes = Number(require('os').totalmem?.() || 0);
	} catch {
		cachedSystemMemoryBytes = 0;
	}
	return cachedSystemMemoryBytes;
}

function getCpuCount(): number {
	if (cachedCpuCount !== null) return cachedCpuCount;
	try {
		const cpus = require('os').cpus?.();
		cachedCpuCount = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;
	} catch {
		cachedCpuCount = 1;
	}
	return cachedCpuCount;
}

const REQUEST_QUEUE_CONCURRENCY = (() => {
	const baselineTierRps = getBaselineTierRps();
	const cpuCount = getCpuCount();
	const memoryUsage = process.memoryUsage?.() || { rss: 0, external: 0, heapUsed: 0 };
	const totalMemoryBytes = Number(memoryUsage.rss || 0);
	const externalMemoryBytes = Number((memoryUsage as { external?: number }).external || 0);
	const heapUsedBytes = Number((memoryUsage as { heapUsed?: number }).heapUsed || 0);
	const activeRuntimeBytes = Math.max(0, totalMemoryBytes - heapUsedBytes - externalMemoryBytes);
	const systemMemoryBytes = getSystemMemoryBytes();
	const memoryPressureRatio =
		systemMemoryBytes > 0 ? totalMemoryBytes / systemMemoryBytes : 0;
	const externalPressureRatio =
		systemMemoryBytes > 0 ? externalMemoryBytes / systemMemoryBytes : 0;
	const activeRuntimePressureRatio =
		systemMemoryBytes > 0 ? activeRuntimeBytes / systemMemoryBytes : 0;
	const severeRuntimePressure =
		externalPressureRatio >= 0.03 ||
		memoryPressureRatio >= 0.12 ||
		activeRuntimePressureRatio >= 0.03;
	const elevatedRuntimePressure =
		externalPressureRatio >= 0.02 ||
		memoryPressureRatio >= 0.09 ||
		activeRuntimePressureRatio >= 0.02;
	const memoryAwareCap =
		severeRuntimePressure ? 1 :
		externalPressureRatio >= 0.025 || memoryPressureRatio >= 0.1 ? 2 :
		externalPressureRatio >= 0.02 || memoryPressureRatio >= 0.08 ? 3 :
		externalPressureRatio >= 0.015 || memoryPressureRatio >= 0.06 ? 4 :
		memoryPressureRatio >= 0.04 ? 6 : 24;
	const minimumSuggestedConcurrency =
		memoryPressureRatio >= 0.08 || externalPressureRatio >= 0.015 ? 1 : 2;
	const scaledByTier = Math.max(
		minimumSuggestedConcurrency,
		Math.min(24, Math.ceil(baselineTierRps / 2))
	);
	const configured = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? scaledByTier);
	if (!Number.isFinite(configured) || configured <= 0) {
		return Math.max(minimumSuggestedConcurrency, Math.min(memoryAwareCap, scaledByTier));
	}
	return Math.max(1, Math.min(memoryAwareCap, Math.floor(configured)));
})();const REQUEST_QUEUE_MAX_PENDING = (() => {
	const baselineTierRps = getBaselineTierRps();
	const suggestedDefault = Math.min(
		2048,
		Math.max(256, REQUEST_QUEUE_CONCURRENCY * 48, baselineTierRps * 12)
	);
	const raw = Number(
		process.env.REQUEST_QUEUE_MAX_PENDING ?? String(suggestedDefault)
	);
	if (!Number.isFinite(raw) || raw < 0) return suggestedDefault;
	return Math.floor(raw);
})();

const REQUEST_QUEUE_MAX_WAIT_MS = (() => {
	const raw = Number(process.env.REQUEST_QUEUE_MAX_WAIT_MS ?? 15_000);
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	return Math.floor(raw);
})();

const MEMORY_PRESSURE_IDLE_SMALL_BODY_BYPASS_BYTES = (() => {
	const raw = Number(
		process.env.MEMORY_PRESSURE_IDLE_SMALL_BODY_BYPASS_BYTES ?? 16 * 1024
	);
	if (!Number.isFinite(raw) || raw < 0) return 16 * 1024;
	return Math.floor(raw);
})();

const REQUEST_BODY_READ_QUEUE_CONCURRENCY = (() => {
	const fallback = Math.max(4, Math.min(REQUEST_QUEUE_CONCURRENCY, 8));
	const raw = Number(
		process.env.REQUEST_BODY_READ_QUEUE_CONCURRENCY ?? fallback
	);
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.floor(raw);
})();

const REQUEST_BODY_READ_QUEUE_MAX_PENDING = (() => {
	const fallback = Math.max(256, REQUEST_BODY_READ_QUEUE_CONCURRENCY * 64);
	const raw = Number(
		process.env.REQUEST_BODY_READ_QUEUE_MAX_PENDING ?? fallback
	);
	if (!Number.isFinite(raw) || raw < 0) return fallback;
	return Math.floor(raw);
})();

const RESPONSES_QUEUE_CONCURRENCY = (() => {
	const fallback = Math.max(4, Math.min(REQUEST_QUEUE_CONCURRENCY, 12));
	const raw = Number(
		process.env.RESPONSES_QUEUE_CONCURRENCY ?? fallback
	);
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.floor(raw);
})();

const RESPONSES_QUEUE_MAX_PENDING = (() => {
	const fallback = Math.max(256, RESPONSES_QUEUE_CONCURRENCY * 96);
	const raw = Number(
		process.env.RESPONSES_QUEUE_MAX_PENDING ?? fallback
	);
	if (!Number.isFinite(raw) || raw < 0) return fallback;
	return Math.floor(raw);
})();

const RESPONSES_QUEUE_MAX_WAIT_MS = (() => {
	const raw = Number(process.env.RESPONSES_QUEUE_MAX_WAIT_MS ?? REQUEST_QUEUE_MAX_WAIT_MS);
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	return Math.floor(raw);
})();

export const requestBodyReadQueue = new RequestQueue(
	REQUEST_BODY_READ_QUEUE_CONCURRENCY,
	{
		label: 'request-body-read',
		maxPending: REQUEST_BODY_READ_QUEUE_MAX_PENDING,
		memoryPressureGuard: true
	}
);

export function isQueueSaturated(
	queue: RequestQueue,
	options?: { pendingRatioThreshold?: number; inFlightRatioThreshold?: number }
): boolean {
	const snapshot = queue.snapshot();
	const pendingRatioThreshold = Math.min(
		1,
		Math.max(0, options?.pendingRatioThreshold ?? 0.8)
	);
	const inFlightRatioThreshold = Math.min(
		1,
		Math.max(0, options?.inFlightRatioThreshold ?? 1)
	);
	const pendingRatio =
		snapshot.maxPending > 0 ? snapshot.pending / snapshot.maxPending : 0;
	const inFlightRatio =
		snapshot.concurrency > 0 ? snapshot.inFlight / snapshot.concurrency : 0;
	return (
		snapshot.pending >= snapshot.maxPending ||
		pendingRatio >= pendingRatioThreshold ||
		inFlightRatio >= inFlightRatioThreshold
	);
}

export async function acquireRequestBodyReadPermit(
	label: string,
	contentLengthBytes?: number | null
): Promise<() => void> {
	const normalizedContentLengthBytes =
		typeof contentLengthBytes === 'number' && Number.isFinite(contentLengthBytes)
			? Math.max(0, Math.floor(contentLengthBytes))
			: null;
	const smallBodyBypassBytes = Math.max(
		0,
		Number(process.env.REQUEST_BODY_READ_SMALL_BODY_BYPASS_BYTES ?? 65536)
	);
	const memoryPressureLabel =
		normalizedContentLengthBytes !== null
			? `${label} content_length=${normalizedContentLengthBytes}`
			: label;
	rejectOnMemoryPressure(memoryPressureLabel, contentLengthBytes);
	const release = await requestBodyReadQueue.acquire();
	try {
		rejectOnMemoryPressure(memoryPressureLabel, contentLengthBytes);
		return release;
	} catch (error) {
		release();
		throw error;
	}
}

export const requestQueue = new RequestQueue(REQUEST_QUEUE_CONCURRENCY, {
	label: 'request-queue',
	maxPending: REQUEST_QUEUE_MAX_PENDING,
	maxWaitMs: REQUEST_QUEUE_MAX_WAIT_MS,
	memoryPressureGuard: true
});

export const responsesQueue = new RequestQueue(RESPONSES_QUEUE_CONCURRENCY, {
	label: 'responses-queue',
	maxPending: RESPONSES_QUEUE_MAX_PENDING,
	maxWaitMs: RESPONSES_QUEUE_MAX_WAIT_MS,
	memoryPressureGuard: true
});

export function getRequestQueueForLane(lane: RequestQueueLane = 'shared'): RequestQueue {
	return lane === 'responses' ? responsesQueue : requestQueue;
}

export function getRequestQueueSnapshot(extra: Record<string, unknown> = {}) {
	const snapshot = requestQueue.snapshot();
	const concurrency = Math.max(1, Number(snapshot.concurrency) || 0);
	const maxPending = Math.max(1, Number(snapshot.maxPending) || 0);
	const inFlight = Math.max(0, Number(snapshot.inFlight) || 0);
	const pending = Math.max(0, Number(snapshot.pending) || 0);
	const availableConcurrency = Math.max(0, concurrency - inFlight);
	const availablePending = Math.max(0, maxPending - pending);
	const utilization =
		concurrency > 0 ? Number((inFlight / concurrency).toFixed(3)) : 0;
	const pendingUtilization =
		maxPending > 0 ? Number((pending / maxPending).toFixed(3)) : 0;
	const waitMs = Math.max(0, Number(snapshot.maxWaitMs) || 0);
	const waitSeconds = Number((waitMs / 1000).toFixed(3));
	const pressureScore = Number(
		Math.max(utilization, pendingUtilization).toFixed(3)
	);
	const idle = inFlight === 0 && pending === 0;
	const queueState = idle
		? 'idle'
		: inFlight >= concurrency && pending > 0
			? 'overloaded'
			: pending > 0
				? 'backlogged'
				: inFlight >= concurrency
					? 'saturated'
					: 'active';
		const saturated = inFlight >= concurrency;
		const nearSaturation = utilization >= 0.9 || pendingUtilization >= 0.9;
		const backlogged = pending > 0;
		const overloaded = saturated && pending > 0;
		const runtimeCapacityPressureOrigin = idle
			? 'runtime_capacity_idle'
			: overloaded
				? 'runtime_capacity_with_queue_overload'
				: saturated
					? 'runtime_capacity_with_queue_saturation'
					: backlogged
						? 'runtime_capacity_with_queue_backlog'
						: 'runtime_capacity_with_queue_activity';
		const waitTimeoutPressureOrigin = overloaded
			? 'queue_overload'
			: saturated
				? 'queue_saturation'
				: backlogged
					? 'queue_backlog'
					: idle
						? 'queue_idle'
						: 'queue_activity';
		const pressureTier = idle
			? 'idle'
			: overloaded || pressureScore >= 1
				? 'critical'
				: nearSaturation || pressureScore >= 0.9
					? 'high'
					: pressureScore >= 0.6
						? 'elevated'
						: 'normal';
		const snapshotAny = snapshot as any;
		const memoryPressureReasons = Array.isArray(snapshotAny?.memoryPressureReasons)
			? snapshotAny.memoryPressureReasons.map((reason: unknown) => String(reason || '').toLowerCase())
			: [];
		const memoryPressureActive = Boolean(snapshotAny?.memoryPressureActive)
			|| memoryPressureReasons.length > 0;
		const swapOnlyPressure =
			memoryPressureReasons.length > 0 &&
			memoryPressureReasons.every((reason: string) => reason.includes('swap_used_mb='));
		const processMemoryBytes = Number(snapshotAny?.memorySnapshot?.rssBytes || 0)
			+ Number(snapshotAny?.memorySnapshot?.externalBytes || 0)
			+ Number(snapshotAny?.memorySnapshot?.heapUsedBytes || 0);
		const processMemoryPressure = processMemoryBytes > 0
			? processMemoryBytes >= Math.max(1, Math.floor(getSystemMemoryBytes() * 0.7))
			: false;
		const runtimeCapacityPressure = memoryPressureActive && idle && (!swapOnlyPressure || processMemoryPressure);
		const memoryPressureWithLowQueueDepth =
			memoryPressureActive &&
			inFlight === 0 &&
			pending === 0;
		const runtimeCapacityLikely =
			idle ||
			(inFlight <= 1 && pending === 0) ||
			(memoryPressureActive && !overloaded && pending <= Math.max(64, Math.floor(maxPending * 0.05)));
		const runtimeCapacityPressureLikely = Boolean(
			memoryPressureActive && (idle || (inFlight <= Math.max(1, Math.ceil(concurrency * 0.25)) && pending <= 1))
		)
			|| Boolean(snapshotAny?.memoryPressure?.active)
			|| Boolean(snapshotAny?.memoryPressure?.reasons?.length);
		const memoryPressureLikely = memoryPressureActive || (runtimeCapacityLikely && pressureTier !== 'critical');
		const operatorRecoveryHint = memoryPressureLikely
			? 'Runtime memory pressure is likely dominating over queue contention; reduce rss/external/swap usage, recycle the worker, or shed large requests before increasing concurrency.'
			: overloaded
				? 'Queue contention is likely contributing; reduce intake rate or add capacity before retry amplification builds.'
				: 'Retry after a short delay and inspect queue occupancy plus runtime memory snapshots if pressure persists.';
		const failureOriginHint = memoryPressureLikely
			? 'runtime_capacity'
			: overloaded || saturated
				? 'request_queue'
				: 'mixed';
		const bottleneckHint = memoryPressureLikely
			? 'memory-pressure'
			: overloaded
				? 'queue-overload'
				: backlogged
					? 'queue-backlog'
					: saturated
						? 'concurrency-saturation'
						: 'none';
		const bottleneck = memoryPressureLikely
			? 'memory-pressure'
			: runtimeCapacityLikely
				? 'runtime-capacity'
				: 'queue-capacity';
		const failureOrigin = memoryPressureLikely
			? 'memory_pressure'
			: runtimeCapacityLikely
				? 'runtime_capacity'
				: 'queue_capacity';
		const healthSummary = `${queueState}|tier=${pressureTier}|bottleneck=${bottleneck}|origin=${failureOrigin}|u=${utilization.toFixed(2)}|p=${pendingUtilization.toFixed(2)}|w=${waitMs}ms|in=${inFlight}/${concurrency}|q=${pending}/${maxPending}`;
		return {
		...snapshot,
		utilization,
		pendingUtilization,
		pressureScore,
		pressureTier,
		availableConcurrency,
		availablePending,
		waitMs,
		waitSeconds,
		idle,
		queueState,
		healthSummary,
		saturated,
		nearSaturation,
		backlogged,
		overloaded,
		...extra
	};
}
