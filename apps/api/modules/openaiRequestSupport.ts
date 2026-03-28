export function getHeaderValue(
	headers: Record<string, any>,
	name: string
): string | undefined {
	if (!headers || !name) return undefined;
	const normalizedName = String(name).toLowerCase();
	const headerBag = headers as any;
	const normalizeHeaderValue = (value: any): string | undefined => {
		if (Array.isArray(value)) {
			const joined = value
				.map((entry) => normalizeHeaderValue(entry) || '')
				.filter(Boolean)
				.join(', ');
			return joined || undefined;
		}
		if (typeof value === 'string') {
			const trimmed = value.trim();
			return trimmed || undefined;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		return undefined;
	};
	const direct =
		headerBag[name] ??
		headerBag[normalizedName] ??
		headerBag[name.toUpperCase()];
	const normalizedDirect = normalizeHeaderValue(direct);
	if (normalizedDirect) return normalizedDirect;

	if (typeof headerBag.get === 'function') {
		const fetched = headerBag.get(name) ?? headerBag.get(normalizedName);
		const normalizedFetched = normalizeHeaderValue(fetched);
		if (normalizedFetched) return normalizedFetched;
	}

	if (typeof headerBag.entries === 'function') {
		for (const [key, value] of headerBag.entries() as Iterable<[string, any]>) {
			if (String(key).toLowerCase() !== normalizedName) continue;
			const normalizedEntry = normalizeHeaderValue(value);
			if (normalizedEntry) return normalizedEntry;
		}
	}

	const rawHeaders = Array.isArray(headerBag.rawHeaders)
		? headerBag.rawHeaders
		: Array.isArray(headerBag.raw_headers)
			? headerBag.raw_headers
			: null;
	if (rawHeaders) {
		for (let index = 0; index < rawHeaders.length - 1; index += 2) {
			if (String(rawHeaders[index]).toLowerCase() !== normalizedName) continue;
			const normalizedRaw = normalizeHeaderValue(rawHeaders[index + 1]);
			if (normalizedRaw) return normalizedRaw;
		}
	}

	const rawHeaderMap =
		headerBag.raw && typeof headerBag.raw === 'object'
			? headerBag.raw
			: headerBag.headers && typeof headerBag.headers === 'object'
				? headerBag.headers
				: null;
	if (rawHeaderMap && !Array.isArray(rawHeaderMap)) {
		for (const [key, value] of Object.entries(rawHeaderMap as Record<string, any>)) {
			if (String(key).toLowerCase() !== normalizedName) continue;
			const normalizedRawMapValue = normalizeHeaderValue(value);
			if (normalizedRawMapValue) return normalizedRawMapValue;
		}
	}

	return undefined;
}

export function normalizeImageFetchReferer(raw?: string): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return parsed.origin;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function extractUsageTokens(usage: any): {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
} {
	if (!usage || typeof usage !== 'object') return {};

	const promptTokens =
		typeof usage.prompt_tokens === 'number'
			? usage.prompt_tokens
			: typeof usage.input_tokens === 'number'
				? usage.input_tokens
				: undefined;
	const completionTokens =
		typeof usage.completion_tokens === 'number'
			? usage.completion_tokens
			: typeof usage.output_tokens === 'number'
				? usage.output_tokens
				: undefined;
	const totalTokens =
		typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;

	return { promptTokens, completionTokens, totalTokens };
}

export function createSseDataParser(
	onData: (data: string, eventName?: string) => void
) {
	let buffer = '';
	let currentEvent = '';
	let currentDataLines: string[] = [];

	const flushEvent = () => {
		if (currentDataLines.length === 0) {
			currentEvent = '';
			return;
		}
		onData(currentDataLines.join('\n'), currentEvent || undefined);
		currentDataLines = [];
		currentEvent = '';
	};

	return (chunk: string) => {
		buffer += chunk;

		while (true) {
			const lineBreakIndex = buffer.indexOf('\n');
			if (lineBreakIndex === -1) break;

			let line = buffer.slice(0, lineBreakIndex);
			buffer = buffer.slice(lineBreakIndex + 1);

			if (line.endsWith('\r')) line = line.slice(0, -1);

			if (!line) {
				flushEvent();
				continue;
			}
			if (line.startsWith(':')) {
				continue;
			}
			if (line.startsWith('event:')) {
				currentEvent = line.slice(6).trim();
				continue;
			}
			if (line.startsWith('data:')) {
				currentDataLines.push(line.slice(5).trimStart());
			}
		}
	};
}

type SseResponseWriter = {
	write: (chunk: any) => unknown;
	completed?: boolean;
	on?: (event: string, listener: (...args: any[]) => void) => unknown;
	once?: (event: string, listener: (...args: any[]) => void) => unknown;
	off?: (event: string, listener: (...args: any[]) => void) => unknown;
	removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
};

export function startSseHeartbeat(
	response: SseResponseWriter,
	options?: {
		intervalMs?: number;
		comment?: string;
		onStop?: (stats: { emitted: number; lastWriteAt: number; lastHeartbeatAt?: number }) => void;
	}
) {
	const intervalMs = Math.max(1_000, options?.intervalMs ?? 15_000);
	const payload = `: ${options?.comment ?? 'keep-alive'}\n\n`;
	let stopped = false;
	let lastWriteAt = Date.now();
	let emitted = 0;
	let lastHeartbeatAt: number | undefined;

	const originalWrite = response.write.bind(response) as (chunk: any) => unknown;
	const teardownListeners: Array<() => void> = [];
	const stop = () => {
		if (stopped) return;
		stopped = true;
		response.write = originalWrite;
		clearInterval(timer);
		for (const teardown of teardownListeners.splice(0)) {
			try {
				teardown();
			} catch {
				// Ignore listener teardown failures during stream shutdown.
			}
		}
		try {
			options?.onStop?.({ emitted, lastWriteAt, lastHeartbeatAt });
		} catch {
			// Ignore teardown callback failures during stream shutdown.
		}
	};
	response.write = (chunk: any) => {
		if (stopped || response.completed) return false;
		try {
			const result = originalWrite(chunk);
			if (result === false) {
				stop();
				return result;
			}
			lastWriteAt = Date.now();
			return result;
		} catch (error) {
			stop();
			throw error;
		}
	};

	const registeredStopEvents = new Set<string>();
	const registerStopListener = (event: string) => {
		const normalizedEvent = String(event || '').trim();
		if (!normalizedEvent || registeredStopEvents.has(normalizedEvent)) return;
		registeredStopEvents.add(normalizedEvent);
		const listener = () => stop();
		if (typeof response.once === 'function') {
			response.once(normalizedEvent, listener);
			if (typeof response.off === 'function') {
				teardownListeners.push(() => response.off?.(normalizedEvent, listener));
			} else if (typeof response.removeListener === 'function') {
				teardownListeners.push(() => response.removeListener?.(normalizedEvent, listener));
			}
			return;
		}
		if (typeof response.on === 'function') {
			response.on(normalizedEvent, listener);
			if (typeof response.off === 'function') {
				teardownListeners.push(() => response.off?.(normalizedEvent, listener));
			} else if (typeof response.removeListener === 'function') {
				teardownListeners.push(() => response.removeListener?.(normalizedEvent, listener));
			}
		}
	};
	registerStopListener('close');
	registerStopListener('finish');
	registerStopListener('end');
	registerStopListener('aborted');
	registerStopListener('error');
	registerStopListener('abort');
	registerStopListener('disconnect');

	const writeHeartbeat = () => {
		if (stopped) return;
		const responseAny = response as any;
		const socketLike = responseAny?.socket ?? responseAny?.stream ?? responseAny?.raw;
		const now = Date.now();
		const noLongerWritable =
			response.completed ||
			responseAny?.destroyed === true ||
			responseAny?.writableEnded === true ||
			responseAny?.writableFinished === true ||
			responseAny?.writableAborted === true ||
			responseAny?.writable === false ||
			responseAny?.closed === true ||
			responseAny?.aborted === true ||
			responseAny?.finished === true ||
			responseAny?.ended === true ||
			responseAny?.errored === true ||
			responseAny?.headersSent === false ||
			socketLike?.destroyed === true ||
			socketLike?.writable === false ||
			socketLike?.closed === true ||
			socketLike?.errored === true;
		if (noLongerWritable) {
			stop();
			return;
		}
		const pendingDrain =
			responseAny?.writableNeedDrain === true ||
			socketLike?.writableNeedDrain === true;
		if (pendingDrain) return;
		if (now - lastWriteAt < intervalMs) return;
		try {
			const result = response.write(payload);
			if (result === false) {
				const pendingDrainAfterWrite =
					responseAny?.writableNeedDrain === true ||
					socketLike?.writableNeedDrain === true;
				if (
					response.completed ||
					responseAny?.destroyed === true ||
					responseAny?.writableEnded === true ||
					responseAny?.writableFinished === true ||
					responseAny?.closed === true ||
					responseAny?.aborted === true ||
					socketLike?.destroyed === true ||
					socketLike?.writable === false ||
					(!pendingDrainAfterWrite && socketLike?.closed === true)
				) {
					stop();
				}
				return;
			}
			emitted += 1;
			lastWriteAt = now;
			lastHeartbeatAt = now;
		} catch {
			stop();
		}
	};
	const timer = setInterval(writeHeartbeat, intervalMs);
	if (typeof (timer as { unref?: () => void }).unref === 'function') {
		timer.unref();
	}

	const stopWithStats = Object.assign(stop, {
		getHeartbeatStats: () => ({
			emitted,
			lastWriteAt,
			lastHeartbeatAt,
			intervalMs,
			stopped,
		}),
	});

	return stopWithStats;
}
