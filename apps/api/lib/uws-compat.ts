import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';

type NextFunction = () => void;
type Handler = (request: Request, response: Response, next: NextFunction) => any;
type ErrorHandler = (request: Request, response: Response, error: unknown) => any;
type NotFoundHandler = (request: Request, response: Response) => any;

type HTTPMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head' | 'any';

interface RouteDefinition {
    method: HTTPMethod;
    path: string;
    handlers: Handler[];
}

interface MiddlewareDefinition {
    path: string;
    handlers: Handler[];
}

interface ServerOptions {
    max_body_length?: number;
}

interface RegisteredRoute {
    method: HTTPMethod;
    fullPath: string;
    stack: Handler[];
    maxBodyLength: number;
    errorHandler?: ErrorHandler;
}

interface RegisteredFallback {
    fullPath: string;
    handler: NotFoundHandler;
    maxBodyLength: number;
}

interface WsRoute {
    path: string;
    handler: (ws: WSWrapper, req: RequestContext) => void;
}

interface RequestInitOptions {
    bodyReader: () => Promise<Buffer>;
    ip?: string;
}

export interface RequestContext {
    path: string;
    url: string;
    method: string;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
}

const DEFAULT_MAX_BODY_LENGTH = 50 * 1024 * 1024;

if (typeof (globalThis as any).Bun?.serve !== 'function') {
    throw new Error('Bun runtime required for apps/api/lib/uws-compat.ts');
}

function normalizePath(path: string): string {
    if (!path) return '/';
    let normalized = path.startsWith('/') ? path : `/${path}`;
    if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
}

function joinPaths(prefix: string, suffix: string): string {
    const a = normalizePath(prefix);
    const b = normalizePath(suffix);
    if (a === '/') return b;
    if (b === '/') return a;
    return `${a}${b}`;
}

function parseQuery(queryString: string): Record<string, string | string[]> {
    const params = new URLSearchParams(queryString || '');
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
        if (key in result) {
            const current = result[key];
            if (Array.isArray(current)) {
                current.push(value);
            } else {
                result[key] = [current, value];
            }
        } else {
            result[key] = value;
        }
    }
    return result;
}

function splitPath(path: string): string[] {
    return normalizePath(path).split('/').filter(Boolean);
}

function matchPath(pathPattern: string, actualPath: string): Record<string, string> | null {
    const patternParts = splitPath(pathPattern);
    const actualParts = splitPath(actualPath);
    const params: Record<string, string> = {};

    let i = 0;
    let j = 0;
    while (i < patternParts.length) {
        const patternPart = patternParts[i];
        if (patternPart === '*') {
            return params;
        }
        const actualPart = actualParts[j];
        if (actualPart === undefined) {
            return null;
        }
        if (patternPart.startsWith(':')) {
            params[patternPart.slice(1)] = decodeURIComponent(actualPart);
        } else if (patternPart !== actualPart) {
            return null;
        }
        i += 1;
        j += 1;
    }

    if (j != actualParts.length) {
        return null;
    }

    return params;
}

function toUint8Array(data: string | Buffer | ArrayBufferLike | Uint8Array): Uint8Array {
    if (typeof data === 'string') {
        return new TextEncoder().encode(data);
    }
    if (Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof Uint8Array) {
        return data;
    }
    return new Uint8Array(data);
}

function toArrayBuffer(data: string | Buffer | ArrayBuffer | ArrayBufferView): ArrayBuffer {
    if (typeof data === 'string') {
        return new TextEncoder().encode(data).buffer;
    }
    if (data instanceof ArrayBuffer) {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    }
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
}

function buildHeadersRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
        record[key.toLowerCase()] = value;
    });
    return record;
}

function resolveClientIp(server: any, request: globalThis.Request, headers: Record<string, string>): string | undefined {
    const forwarded = headers['x-forwarded-for'] || headers['x-real-ip'];
    if (forwarded) return forwarded.split(',')[0].trim();
    try {
        return server?.requestIP?.(request)?.address;
    } catch {
        return undefined;
    }
}

function buildRequestContext(request: globalThis.Request, params: Record<string, string>): RequestContext {
    const url = new URL(request.url);
    return {
        path: normalizePath(url.pathname),
        url: `${normalizePath(url.pathname)}${url.search}`,
        method: request.method.toUpperCase(),
        params,
        query: parseQuery(url.search.slice(1)),
        headers: buildHeadersRecord(request.headers),
    };
}

export class Request {
    public path: string;
    public url: string;
    public method: string;
    public params: Record<string, string>;
    public query: Record<string, string | string[]>;
    public headers: Record<string, string>;
    public ip?: string;
    public completed = false;
    public requestId: string;

    private bodyCache?: Promise<Buffer>;
    private bodyReader: () => Promise<Buffer>;
    private maxBodyLength: number;
    private bodyCacheReleased = false;

    constructor(ctx: RequestContext, maxBodyLength: number, options: RequestInitOptions) {
        this.path = ctx.path;
        this.url = ctx.url;
        this.method = ctx.method;
        this.params = ctx.params;
        this.query = ctx.query;
        this.headers = ctx.headers;
        this.ip = options.ip;
        this.requestId = this.headers['x-request-id'] || `req_${randomUUID()}`;
        this.bodyReader = options.bodyReader;
        this.maxBodyLength = maxBodyLength;
    }

    async json<T = any>(): Promise<T> {
        return JSON.parse(await this.text());
    }

    async text(): Promise<string> {
        return (await this.buffer()).toString('utf8');
    }

    async buffer(): Promise<Buffer> {
        if (this.bodyCacheReleased) {
            throw new Error('Request body cache was released and cannot be read again.');
        }
        if (!this.bodyCache) {
            this.bodyCache = (async () => {
                const body = await this.bodyReader();
                if (body.length > this.maxBodyLength) {
                    throw new Error('Payload too large');
                }
                return body;
            })();
        }
        return this.bodyCache;
    }

    releaseBodyCache(): void {
        this.bodyCacheReleased = true;
        this.bodyCache = undefined;
    }
}

export class Response {
    public completed = false;
    public started = false;

    private statusCode = 200;
    private headers: Record<string, string> = {};
    private errorId?: string;
    private bunController: ReadableStreamDefaultController<Uint8Array> | null = null;
    private bunStream: ReadableStream<Uint8Array>;
    private bunResponse: globalThis.Response | null = null;
    private bodyChunks: Uint8Array[] = [];
    private shouldBufferBody = true;
    private startedPromise: Promise<void>;
    private resolveStarted!: () => void;

    constructor() {
        this.startedPromise = new Promise<void>((resolve) => {
            this.resolveStarted = resolve;
        });
        this.bunStream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.bunController = controller;
                for (const chunk of this.bodyChunks) {
                    controller.enqueue(chunk);
                }
            },
            cancel: () => {
                this.completed = true;
                this.shouldBufferBody = false;
                this.bodyChunks = [];
                this.bunController = null;
            },
        });
    }

    private attachErrorIdToBody(body: string): string {
        if (!this.errorId) return body;
        try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const record = parsed as Record<string, any>;
                if (!('error_id' in record)) record.error_id = this.errorId;
                if (typeof record.error === 'string' && !record.error.includes(this.errorId)) {
                    record.error = `${record.error} (error_id: ${this.errorId})`;
                } else if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
                    const errorObj = record.error as Record<string, any>;
                    if (!('id' in errorObj)) errorObj.id = this.errorId;
                    if (typeof errorObj.message === 'string' && !errorObj.message.includes(this.errorId)) {
                        errorObj.message = `${errorObj.message} (error_id: ${this.errorId})`;
                    }
                } else if (typeof record.message === 'string' && !record.message.includes(this.errorId)) {
                    record.message = `${record.message} (error_id: ${this.errorId})`;
                }
                return JSON.stringify(record);
            }
        } catch {
            // ignore
        }
        if (body.includes(this.errorId)) return body;
        const suffix = `error_id: ${this.errorId}`;
        return body.endsWith('\n') ? `${body}${suffix}` : `${body}\n${suffix}`;
    }

    private markStarted(): void {
        if (this.started) return;
        this.started = true;
        this.resolveStarted();
    }

    private disableBodyBuffering(): void {
        this.shouldBufferBody = false;
        this.bodyChunks = [];
    }

    private enqueue(chunk?: string | Buffer | ArrayBufferLike | Uint8Array): void {
        if (chunk === undefined) return;
        const encoded = toUint8Array(chunk);
        if (this.shouldBufferBody) {
            this.bodyChunks.push(encoded);
        }
        if (this.bunController) {
            try {
                this.bunController.enqueue(encoded);
            } catch {
                this.completed = true;
                this.bunController = null;
            }
        }
    }

    private getCompletedBody(): Uint8Array | null {
        if (this.bodyChunks.length === 0) return null;
        if (this.bodyChunks.length === 1) return this.bodyChunks[0];
        const total = this.bodyChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.bodyChunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return merged;
    }

    waitForStart(): Promise<void> {
        return this.startedPromise;
    }

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    setHeader(name: string, value: string): this {
        this.headers[name] = value;
        return this;
    }

    getHeader(name: string): string | undefined {
        return this.headers[name];
    }

    setErrorId(errorId: string): this {
        this.errorId = errorId;
        return this;
    }

    json(payload: any): void {
        if (this.completed) return;
        this.setHeader('Content-Type', 'application/json');
        const shouldAttachErrorId = Boolean(this.errorId)
            && payload && typeof payload === 'object' && !Array.isArray(payload)
            && (this.statusCode >= 400 || 'error' in payload || (payload as Record<string, any>).type === 'error');
        if (shouldAttachErrorId && this.errorId) {
            const payloadRecord = payload as Record<string, any>;
            if (!('error_id' in payloadRecord)) payloadRecord.error_id = this.errorId;
            if (typeof payloadRecord.error === 'string' && !payloadRecord.error.includes(this.errorId)) {
                payloadRecord.error = `${payloadRecord.error} (error_id: ${this.errorId})`;
            } else if (payloadRecord.error && typeof payloadRecord.error === 'object' && !Array.isArray(payloadRecord.error)) {
                const errorObj = payloadRecord.error as Record<string, any>;
                if (!('id' in errorObj)) errorObj.id = this.errorId;
                if (typeof errorObj.message === 'string' && !errorObj.message.includes(this.errorId)) {
                    errorObj.message = `${errorObj.message} (error_id: ${this.errorId})`;
                }
            } else if (typeof payloadRecord.message === 'string' && !payloadRecord.message.includes(this.errorId)) {
                payloadRecord.message = `${payloadRecord.message} (error_id: ${this.errorId})`;
            }
        }
        this.markStarted();
        this.enqueue(JSON.stringify(payload));
        this.bunController?.close();
        this.completed = true;
    }

    write(chunk: string | Buffer | ArrayBufferLike | Uint8Array): this {
        if (this.completed) return this;
        this.markStarted();
        this.enqueue(chunk);
        return this;
    }

    end(chunk?: string | Buffer | ArrayBufferLike | Uint8Array): void {
        if (this.completed) return;
        let output = chunk;
        const shouldAttachErrorId = Boolean(this.errorId) && this.statusCode >= 400 && chunk !== undefined;
        if (shouldAttachErrorId && this.errorId) {
            if (Buffer.isBuffer(chunk)) {
                output = Buffer.from(this.attachErrorIdToBody(chunk.toString('utf8')));
            } else if (typeof chunk === 'string') {
                output = this.attachErrorIdToBody(chunk);
            }
        }
        this.markStarted();
        if (output !== undefined) {
            this.enqueue(output);
        }
        this.bunController?.close();
        this.completed = true;
    }

    toWebResponse(): globalThis.Response {
        if (!this.bunResponse) {
            if (!this.started && !this.completed) {
                this.end();
            }
            const headers = new Headers(this.headers);
            if (this.completed) {
                const body = this.getCompletedBody();
                const completedBody = body ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
                this.bodyChunks = [];
                this.bunResponse = new globalThis.Response(completedBody as any, {
                    status: this.statusCode,
                    headers,
                });
            } else {
                this.disableBodyBuffering();
                this.bunResponse = new globalThis.Response(this.bunStream, {
                    status: this.statusCode,
                    headers,
                });
            }
        }
        return this.bunResponse;
    }
}

async function runHandlers(
    stack: Handler[],
    request: Request,
    response: Response,
    handleError: (error: unknown) => Promise<void> | void,
): Promise<void> {
    const run = async (index: number): Promise<void> => {
        if (response.completed) return;
        const fn = stack[index];
        if (!fn) return;
        let nextCalled = false;
        let nextPromise: Promise<void> | null = null;
        const next: NextFunction = () => {
            nextCalled = true;
            nextPromise = run(index + 1);
        };
        try {
            const maybe = fn(request, response, next);
            if (maybe && typeof (maybe as Promise<any>).then === 'function') {
                await maybe;
            }
            if (nextPromise) {
                await nextPromise;
            } else if (!nextCalled && !response.completed) {
                await run(index + 1);
            }
        } catch (err) {
            await handleError(err);
        }
    };

    await run(0);
}

export class Router {
    protected middlewares: MiddlewareDefinition[] = [];
    protected routes: RouteDefinition[] = [];

    use(pathOrHandler: string | Handler, ...handlers: Handler[]): this {
        if (typeof pathOrHandler === 'string') {
            this.middlewares.push({ path: normalizePath(pathOrHandler), handlers });
        } else {
            this.middlewares.push({ path: '/', handlers: [pathOrHandler, ...handlers] });
        }
        return this;
    }

    private addRoute(method: HTTPMethod, path: string, handlers: Handler[]): this {
        this.routes.push({ method, path: normalizePath(path), handlers });
        return this;
    }

    get(path: string, ...handlers: Handler[]): this { return this.addRoute('get', path, handlers); }
    post(path: string, ...handlers: Handler[]): this { return this.addRoute('post', path, handlers); }
    put(path: string, ...handlers: Handler[]): this { return this.addRoute('put', path, handlers); }
    patch(path: string, ...handlers: Handler[]): this { return this.addRoute('patch', path, handlers); }
    delete(path: string, ...handlers: Handler[]): this { return this.addRoute('delete', path, handlers); }
    options(path: string, ...handlers: Handler[]): this { return this.addRoute('options', path, handlers); }
    head(path: string, ...handlers: Handler[]): this { return this.addRoute('head', path, handlers); }

    register(app: Server, prefix: string, inherited: MiddlewareDefinition[], maxBodyLength: number, errorHandler?: ErrorHandler, notFoundHandler?: NotFoundHandler): void {
        const basePrefix = normalizePath(prefix);

        for (const route of this.routes) {
            const fullPath = joinPaths(basePrefix, route.path);
            const applicableMiddlewares: Handler[] = [];
            for (const middleware of inherited) {
                const inheritedPath = normalizePath(middleware.path);
                if (inheritedPath === '/' || fullPath.startsWith(inheritedPath)) {
                    applicableMiddlewares.push(...middleware.handlers);
                }
            }
            for (const middleware of this.middlewares) {
                const mwPath = joinPaths(basePrefix, middleware.path);
                if (fullPath.startsWith(mwPath)) {
                    applicableMiddlewares.push(...middleware.handlers);
                }
            }
            app.__registerRoute({
                method: route.method,
                fullPath,
                stack: [...applicableMiddlewares, ...route.handlers],
                maxBodyLength,
                errorHandler,
            });
        }

        if (notFoundHandler) {
            app.__registerFallback({
                fullPath: joinPaths(basePrefix, '/*'),
                handler: notFoundHandler,
                maxBodyLength,
            });
        }
    }
}

export class Server extends Router {
    private serverOptions: ServerOptions;
    private errorHandler?: ErrorHandler;
    private notFoundHandler?: NotFoundHandler;
    private registeredRoutes: RegisteredRoute[] = [];
    private registeredFallbacks: RegisteredFallback[] = [];
    private mountedRouters: Array<{ prefix: string; router: Router; leadingMiddleware: Handler[] }> = [];
    private wsRoutes: WsRoute[] = [];
    private bunServer: any;

    constructor(options: ServerOptions = {}) {
        super();
        this.serverOptions = options;
    }

    __registerRoute(route: RegisteredRoute): void {
        this.registeredRoutes.push(route);
    }

    __registerFallback(fallback: RegisteredFallback): void {
        this.registeredFallbacks.push(fallback);
    }

    set_error_handler(handler: ErrorHandler): void {
        this.errorHandler = handler;
    }

    set_not_found_handler(handler: NotFoundHandler): void {
        this.notFoundHandler = handler;
    }

    ws(path: string, handler: (ws: WSWrapper, req: RequestContext) => void): void {
        this.wsRoutes.push({ path: normalizePath(path), handler });
    }

    override use(pathOrHandler: string | Handler, ...handlers: any[]): this {
        const prefix = typeof pathOrHandler === 'string' ? pathOrHandler : '/';
        const routerIndex = handlers.findIndex((handler) => handler instanceof Router);
        if (routerIndex !== -1) {
            const router = handlers[routerIndex] as Router;
            const leadingMiddleware = handlers.filter((_, idx) => idx !== routerIndex) as Handler[];
            this.mountedRouters.push({ prefix: normalizePath(prefix), router, leadingMiddleware });
            return this;
        }
        return super.use(pathOrHandler as any, ...(handlers as Handler[]));
    }

    private buildRegistrations(): void {
        this.registeredRoutes = [];
        this.registeredFallbacks = [];
        const maxBodyLength = this.serverOptions.max_body_length || DEFAULT_MAX_BODY_LENGTH;
        super.register(this, '/', [], maxBodyLength, this.errorHandler, this.notFoundHandler);
        for (const mount of this.mountedRouters) {
            const inherited = [...this.middlewares];
            if (mount.leadingMiddleware.length) {
                inherited.push({ path: mount.prefix, handlers: mount.leadingMiddleware });
            }
            mount.router.register(this, mount.prefix, inherited, maxBodyLength, this.errorHandler, undefined);
        }
    }

    private createErrorHandler(request: Request, response: Response, routeErrorHandler?: ErrorHandler) {
        return async (error: unknown) => {
            response.setErrorId(request.requestId);
            if (routeErrorHandler) {
                try {
                    const maybe = routeErrorHandler(request, response, error);
                    if (maybe && typeof (maybe as Promise<any>).then === 'function') {
                        await maybe;
                    }
                } catch {
                    // ignore secondary failures
                }
            }
            if (!response.completed) {
                response.status(500).json({ error: 'Internal Server Error' });
            }
        };
    }

    private findRegisteredRoute(method: string, path: string): { route: RegisteredRoute; params: Record<string, string> } | null {
        const normalizedMethod = method.toLowerCase();
        const normalizedPath = normalizePath(path);
        for (const route of this.registeredRoutes) {
            if (route.method !== 'any' && route.method !== normalizedMethod) continue;
            const params = matchPath(route.fullPath, normalizedPath);
            if (params) return { route, params };
        }
        return null;
    }

    private findFallback(path: string): RegisteredFallback | null {
        const normalizedPath = normalizePath(path);
        for (const fallback of this.registeredFallbacks) {
            if (matchPath(fallback.fullPath, normalizedPath)) return fallback;
        }
        return null;
    }

    private findWsRoute(path: string): WsRoute | null {
        const normalizedPath = normalizePath(path);
        for (const route of this.wsRoutes) {
            if (route.path === normalizedPath || matchPath(route.path, normalizedPath)) return route;
        }
        return null;
    }

    private async handleNotFound(request: globalThis.Request, server: any): Promise<globalThis.Response> {
        const fallback = this.findFallback(new URL(request.url).pathname);
        if (!fallback) {
            return new globalThis.Response('Not Found', { status: 404 });
        }
        const ctx = buildRequestContext(request, {});
        const wrappedRequest = new Request(ctx, fallback.maxBodyLength, {
            bodyReader: async () => Buffer.from(await request.arrayBuffer()),
            ip: resolveClientIp(server, request, ctx.headers),
        });
        const response = new Response();
        response.setHeader('x-request-id', wrappedRequest.requestId);
        response.setErrorId(wrappedRequest.requestId);
        const maybe = fallback.handler(wrappedRequest, response);
        if (maybe && typeof (maybe as Promise<any>).then === 'function') {
            await maybe;
        }
        if (!response.started && !response.completed) {
            response.status(404).end();
        }
        return response.toWebResponse();
    }

    private async handleRequest(request: globalThis.Request, server: any): Promise<Response | globalThis.Response | undefined> {
        const url = new URL(request.url);
        const upgradeHeader = request.headers.get('upgrade');
        if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
            const wsRoute = this.findWsRoute(url.pathname);
            if (wsRoute) {
                const upgraded = server.upgrade(request, {
                    data: {
                        handler: wsRoute.handler,
                        reqCtx: buildRequestContext(request, {}),
                    },
                });
                if (upgraded) return undefined;
            }
            return new globalThis.Response('WebSocket upgrade failed', { status: 400 });
        }

        const match = this.findRegisteredRoute(request.method, url.pathname);
        if (!match) {
            return this.handleNotFound(request, server);
        }

        const ctx = buildRequestContext(request, match.params);
        const wrappedRequest = new Request(ctx, match.route.maxBodyLength, {
            bodyReader: async () => Buffer.from(await request.arrayBuffer()),
            ip: resolveClientIp(server, request, ctx.headers),
        });
        const response = new Response();
        response.setHeader('x-request-id', wrappedRequest.requestId);
        response.setErrorId(wrappedRequest.requestId);
        const handleError = this.createErrorHandler(wrappedRequest, response, match.route.errorHandler);
        const execution = runHandlers(match.route.stack, wrappedRequest, response, handleError);

        await Promise.race([response.waitForStart(), execution]);
        if (!response.started && !response.completed) {
            await execution;
            if (!response.started && !response.completed) {
                response.end();
            }
        }
        return response.toWebResponse();
    }

    async listen(port: number): Promise<void> {
        this.buildRegistrations();
        const BunRuntime = (globalThis as any).Bun;
        this.bunServer = BunRuntime.serve({
            port,
            reusePort: process.env.BUN_REUSE_PORT === '1',
            fetch: (request: globalThis.Request, server: any) => this.handleRequest(request, server),
            websocket: {
                open: (ws: any) => {
                    const data = ws.data as any;
                    const wrapper = new WSWrapper(ws);
                    data.wrapper = wrapper;
                    data.handler(wrapper, data.reqCtx);
                },
                message: (ws: any, message: any) => {
                    const data = ws.data as any;
                    const wrapper = data.wrapper || WSWrapper.from(ws);
                    if (!wrapper) return;
                    const payload = typeof message === 'string' ? message : toArrayBuffer(message);
                    wrapper.emit('message', payload, typeof message !== 'string');
                },
                close: (ws: any, code: number, reason: any) => {
                    const data = ws.data as any;
                    const wrapper = data.wrapper || WSWrapper.from(ws);
                    if (!wrapper) return;
                    if (typeof reason === 'string') {
                        wrapper.emit('close', code, toArrayBuffer(reason));
                    } else if (reason) {
                        wrapper.emit('close', code, toArrayBuffer(reason));
                    } else {
                        wrapper.emit('close', code, new ArrayBuffer(0));
                    }
                },
            },
        });
    }

    stop(): void {
        try {
            this.bunServer?.stop?.();
        } catch {
            // ignore
        }
    }
}

type WsMessageHandler = (data: string | ArrayBuffer, isBinary?: boolean) => void;
type WsCloseHandler = (code: number, message?: ArrayBuffer) => void;

export class WSWrapper {
    private ws: any;
    private static map = new WeakMap<object, WSWrapper>();
    private messageHandlers: WsMessageHandler[] = [];
    private closeHandlers: WsCloseHandler[] = [];

    constructor(ws: any) {
        this.ws = ws;
        if (ws && typeof ws === 'object') {
            WSWrapper.map.set(ws, this);
        }
    }

    static from(ws: object): WSWrapper | undefined {
        return WSWrapper.map.get(ws);
    }

    on(event: 'message' | 'close', handler: any): this {
        if (event === 'message') this.messageHandlers.push(handler as WsMessageHandler);
        else if (event === 'close') this.closeHandlers.push(handler as WsCloseHandler);
        return this;
    }

    emit(event: 'message' | 'close', ...args: any[]): void {
        if (event === 'message') {
            this.messageHandlers.forEach((handler) => handler(args[0], args[1]));
        } else if (event === 'close') {
            this.closeHandlers.forEach((handler) => handler(args[0], args[1]));
        }
    }

    send(data: string | ArrayBufferLike): void {
        if (!this.ws?.send) return;
        if (typeof data === 'string') {
            this.ws.send(data);
        } else {
            this.ws.send(toUint8Array(data));
        }
    }

    close(code?: number, reason?: string): void {
        if (typeof this.ws?.close === 'function') {
            this.ws.close(code ?? 1000, reason);
        } else if (typeof this.ws?.end === 'function') {
            this.ws.end(code ?? 1000, reason ? Buffer.from(reason) : undefined);
        }
    }
}

const HyperExpressLike = { Server, Router };

export default HyperExpressLike;
