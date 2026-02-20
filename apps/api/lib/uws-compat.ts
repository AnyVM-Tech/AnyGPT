import uWS, { TemplatedApp, HttpRequest, HttpResponse, us_listen_socket } from 'uWebSockets.js';
import { STATUS_CODES } from 'http';

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

interface RequestContext {
    path: string;
    url: string;
    method: string;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
}

function addressBufferToString(buf: ArrayBuffer | undefined): string | undefined {
    if (!buf) return undefined;
    try {
        return Buffer.from(buf).toString('utf8') || undefined;
    } catch {
        return undefined;
    }
}

function resolveClientIp(req: HttpRequest, headers: Record<string, string>): string | undefined {
    const forwarded = headers['x-forwarded-for'] || headers['x-real-ip'];
    if (forwarded) return forwarded.split(',')[0].trim();
    const proxied = (req as any).getProxiedRemoteAddressAsText?.();
    const proxiedStr = addressBufferToString(proxied);
    if (proxiedStr) return proxiedStr;
    const raw = (req as any).getRemoteAddressAsText?.();
    const rawStr = addressBufferToString(raw);
    return rawStr;
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

function extractParamNames(path: string): string[] {
    return path.split('/').filter(Boolean).filter(part => part.startsWith(':')).map(part => part.slice(1));
}

class Request {
    public path: string;
    public url: string;
    public method: string;
    public params: Record<string, string>;
    public query: Record<string, string | string[]>;
    public headers: Record<string, string>;
    public ip?: string;
    public completed = false;

    private bodyCache?: Promise<Buffer>;
    private maxBodyLength: number;
    private res: HttpResponse;
    private req: HttpRequest;

    constructor(res: HttpResponse, req: HttpRequest, ctx: RequestContext, maxBodyLength: number) {
        this.res = res;
        this.req = req;
        this.path = ctx.path;
        this.url = ctx.url;
        this.method = ctx.method;
        this.params = ctx.params;
        this.query = ctx.query;
        this.headers = ctx.headers;
        this.maxBodyLength = maxBodyLength;
        this.ip = resolveClientIp(req, this.headers);
        // Start capturing the request body immediately so data arriving before handlers call .json()/.text() is buffered.
        this.initBodyCapture();
    }

    async json<T = any>(): Promise<T> {
        const text = await this.text();
        return JSON.parse(text);
    }

    async text(): Promise<string> {
        const buf = await this.buffer();
        return buf.toString('utf8');
    }

    async buffer(): Promise<Buffer> {
        return this.bodyCache || Promise.resolve(Buffer.alloc(0));
    }

    // Begin streaming the body immediately to avoid missing data if middlewares do async work before calling .json()
    private initBodyCapture() {
        if (this.bodyCache) return;
        this.bodyCache = new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let received = 0;
            this.res.onData((chunk, isLast) => {
                received += chunk.byteLength;
                if (received > this.maxBodyLength) {
                    this.res.close();
                    return reject(new Error('Payload too large'));
                }
                // Important: Create a copy of the chunk because uWS reuses the memory buffer
                chunks.push(Buffer.from(chunk.slice(0)));
                if (isLast) resolve(Buffer.concat(chunks));
            });
            this.res.onAborted(() => {
                reject(new Error('Request aborted'));
            });
        });
    }
}

class Response {
    public completed = false;

    private statusCode = 200;
    private headersSent = false;
    private headers: Record<string, string> = {};
    private res: HttpResponse;

    private withCork(fn: () => void): void {
        if (this.completed) return;
        const maybeCork = (this.res as any).cork;
        if (typeof maybeCork === 'function') {
            maybeCork.call(this.res, fn);
            return;
        }
        fn();
    }

    constructor(res: HttpResponse) {
        this.res = res;
        this.res.onAborted(() => {
            this.completed = true;
        });
    }

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    setHeader(name: string, value: string): this {
        this.headers[name] = value;
        return this;
    }

    private writeHeadersIfNeeded() {
        if (this.headersSent) return;
        const statusText = STATUS_CODES[this.statusCode] || '';
        this.res.writeStatus(`${this.statusCode} ${statusText}`.trim());
        for (const [key, value] of Object.entries(this.headers)) {
            this.res.writeHeader(key, value);
        }
        this.headersSent = true;
    }

    json(payload: any): void {
        if (this.completed) return;
        this.setHeader('Content-Type', 'application/json');
        const body = JSON.stringify(payload);
        this.withCork(() => {
            this.writeHeadersIfNeeded();
            this.res.end(body);
        });
        this.completed = true;
    }

    write(chunk: string | Buffer): this {
        if (this.completed) return this;
        this.withCork(() => {
            this.writeHeadersIfNeeded();
            this.res.write(chunk as any);
        });
        return this;
    }

    end(chunk?: string | Buffer): void {
        if (this.completed) return;
        this.withCork(() => {
            this.writeHeadersIfNeeded();
            if (chunk !== undefined) {
                this.res.end(chunk as any);
            } else {
                this.res.end();
            }
        });
        this.completed = true;
    }
}

function buildContext(res: HttpResponse, req: HttpRequest, path: string, paramNames: string[]): RequestContext {
    const headers: Record<string, string> = {};
    req.forEach((key, value) => {
        headers[key.toLowerCase()] = value;
    });

    const params: Record<string, string> = {};
    paramNames.forEach((name, index) => {
        params[name] = req.getParameter(index) || '';
    });

    const urlPath = req.getUrl();
    const queryString = req.getQuery();

    return {
        path: urlPath,
        url: queryString ? `${urlPath}?${queryString}` : urlPath,
        method: req.getMethod().toUpperCase(),
        params,
        query: parseQuery(queryString),
        headers,
    };
}

class Router {
    protected middlewares: MiddlewareDefinition[] = [];
    protected routes: RouteDefinition[] = [];

    use(pathOrHandler: string | Handler, ...handlers: Handler[]): this {
        if (typeof pathOrHandler === 'string') {
            const path = normalizePath(pathOrHandler);
            this.middlewares.push({ path, handlers });
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

    /**
     * Registers this router onto a uWS app with an optional prefix and inherited middleware.
     */
    register(app: TemplatedApp, prefix: string, inherited: MiddlewareDefinition[], maxBodyLength: number, errorHandler?: ErrorHandler, notFoundHandler?: NotFoundHandler): void {
        const basePrefix = normalizePath(prefix);

        for (const route of this.routes) {
            const fullPath = joinPaths(basePrefix, route.path);
            const paramNames = extractParamNames(fullPath);

            const applicableMiddlewares: Handler[] = [];
            for (const m of inherited) {
                const inheritedPath = normalizePath(m.path);
                if (inheritedPath === '/' || fullPath.startsWith(inheritedPath)) {
                    applicableMiddlewares.push(...m.handlers);
                }
            }
            for (const m of this.middlewares) {
                const mwPath = joinPaths(basePrefix, m.path);
                if (fullPath.startsWith(mwPath)) {
                    applicableMiddlewares.push(...m.handlers);
                }
            }

            const stack = [...applicableMiddlewares, ...route.handlers];
            const method = route.method === 'any' ? 'any' : route.method;

            const uwsHandler = (res: HttpResponse, req: HttpRequest) => {
                const ctx = buildContext(res, req, fullPath, paramNames);
                const request = new Request(res, req, ctx, maxBodyLength);
                const response = new Response(res);

                const handleError = (error: unknown) => {
                    if (errorHandler) {
                        try {
                            const maybe = errorHandler(request, response, error);
                            if (maybe && typeof (maybe as Promise<any>).then === 'function') {
                                (maybe as Promise<any>).catch(() => {});
                            }
                        } catch {
                            // swallow
                        }
                    }
                    if (!response.completed) {
                        response.status(500).json({ error: 'Internal Server Error' });
                    }
                };

                const run = (i: number) => {
                    if (response.completed) return;
                    const fn = stack[i];
                    if (!fn) return;
                    let nextCalled = false;
                    const next = () => {
                        nextCalled = true;
                        if (!response.completed) run(i + 1);
                    };
                    try {
                        const maybe = fn(request, response, next);
                        if (maybe && typeof (maybe as Promise<any>).then === 'function') {
                            (maybe as Promise<any>).then(() => {
                                if (!nextCalled && !response.completed) run(i + 1);
                            }).catch(err => handleError(err));
                        } else {
                            if (!nextCalled && !response.completed) run(i + 1);
                        }
                    } catch (err) {
                        handleError(err);
                    }
                };

                run(0);
            };

            switch (method) {
                case 'get': app.get(fullPath, uwsHandler); break;
                case 'post': app.post(fullPath, uwsHandler); break;
                case 'put': app.put(fullPath, uwsHandler); break;
                case 'patch': app.patch(fullPath, uwsHandler); break;
                case 'delete': app.del(fullPath, uwsHandler); break;
                case 'options': app.options(fullPath, uwsHandler); break;
                case 'head': app.head(fullPath, uwsHandler); break;
                default: app.any(fullPath, uwsHandler); break;
            }
        }

        // Optionally attach a not-found handler scoped to this prefix
        if (notFoundHandler) {
            const fallbackPath = joinPaths(basePrefix, '/*');
            app.any(fallbackPath, (res, req) => {
                const ctx = buildContext(res, req, fallbackPath, extractParamNames(fallbackPath));
                const request = new Request(res, req, ctx, maxBodyLength);
                const response = new Response(res);
                notFoundHandler(request, response);
                if (!response.completed) response.status(404).end();
            });
        }
    }
}

class Server extends Router {
    private app: TemplatedApp;
    private serverOptions: ServerOptions;
    private errorHandler?: ErrorHandler;
    private notFoundHandler?: NotFoundHandler;
    private listenSocket?: us_listen_socket;

    constructor(options: ServerOptions = {}) {
        super();
        this.serverOptions = options;
        this.app = uWS.App();
    }

    set_error_handler(handler: ErrorHandler): void {
        this.errorHandler = handler;
    }

    set_not_found_handler(handler: NotFoundHandler): void {
        this.notFoundHandler = handler;
    }

    ws(path: string, handler: (ws: WSWrapper, req: RequestContext) => void): void {
        const collectedPath = normalizePath(path);
        this.app.ws(collectedPath, {
            upgrade: (res, req, context) => {
                const headers: Record<string, string> = {};
                req.forEach((key, value) => { headers[key.toLowerCase()] = value; });
                const fullUrl = req.getUrl();
                const query = req.getQuery();
                res.upgrade(
                    { headers, url: fullUrl, query, method: req.getMethod() },
                    req.getHeader('sec-websocket-key'),
                    req.getHeader('sec-websocket-protocol'),
                    req.getHeader('sec-websocket-extensions'),
                    context
                );
            },
            open: (ws) => {
                const data = ws.getUserData() as any;
                const reqCtx: RequestContext = {
                    path: data.url,
                    url: data.query ? `${data.url}?${data.query}` : data.url,
                    method: (data.method || 'GET').toUpperCase(),
                    params: {},
                    query: parseQuery(data.query || ''),
                    headers: data.headers || {},
                };
                const wrapper = new WSWrapper(ws);
                handler(wrapper, reqCtx);
            },
            message: (ws, message, isBinary) => {
                const wrapper = WSWrapper.from(ws);
                if (wrapper) wrapper.emit('message', message, isBinary);
            },
            close: (ws, code, message) => {
                const wrapper = WSWrapper.from(ws);
                if (wrapper) wrapper.emit('close', code, message);
            }
        });
    }

    listen(port: number): Promise<void> {
        // Register all routes collected on this router
        this.register(this.app, '/', [], this.serverOptions.max_body_length || 50 * 1024 * 1024, this.errorHandler, this.notFoundHandler);

        return new Promise((resolve, reject) => {
            this.app.listen(port, (token) => {
                if (!token) {
                    reject(new Error(`Failed to listen on port ${port}`));
                } else {
                    this.listenSocket = token;
                    resolve();
                }
            });
        });
    }

    stop(): void {
        if (this.listenSocket) {
            uWS.us_listen_socket_close(this.listenSocket);
            this.listenSocket = undefined;
        }
    }

    /**
     * Override to ensure nested routers are registered immediately.
     */
    override register(app: TemplatedApp, prefix: string, inherited: MiddlewareDefinition[], maxBodyLength: number, errorHandler?: ErrorHandler, notFoundHandler?: NotFoundHandler): void {
        // Since Server is the root, we ignore incoming inherited middleware and use its own.
        super.register(app, prefix, this.middlewares, maxBodyLength, errorHandler, notFoundHandler);
    }

    /**
     * Mount a router or middleware at a path.
     */
    override use(pathOrHandler: string | Handler, ...handlers: any[]): this {
        const prefix = typeof pathOrHandler === 'string' ? pathOrHandler : '/';
        const maybeRouterIndex = handlers.findIndex(h => h instanceof Router);

        if (maybeRouterIndex !== -1) {
            const router = handlers[maybeRouterIndex] as Router;
            const leadingMiddleware = handlers.filter((_, idx) => idx !== maybeRouterIndex) as Handler[];

            if (leadingMiddleware.length) {
                super.use(prefix, ...leadingMiddleware);
            }

            router.register(this.app, prefix, this.middlewares, this.serverOptions.max_body_length || 50 * 1024 * 1024, this.errorHandler, undefined);
            return this;
        }

        return super.use(pathOrHandler as any, ...(handlers as Handler[]));
    }
}

type WsMessageHandler = (data: string | ArrayBuffer, isBinary: boolean) => void;
type WsCloseHandler = (code: number, message: ArrayBuffer) => void;

type UwsSocket = uWS.WebSocket<any>;

class WSWrapper {
    private ws: UwsSocket;
    private static map = new WeakMap<UwsSocket, WSWrapper>();
    private messageHandlers: WsMessageHandler[] = [];
    private closeHandlers: WsCloseHandler[] = [];

    constructor(ws: UwsSocket) {
        this.ws = ws;
        WSWrapper.map.set(ws, this);
    }

    static from(ws: UwsSocket): WSWrapper | undefined {
        return WSWrapper.map.get(ws);
    }

    on(event: 'message', handler: WsMessageHandler): this;
    on(event: 'close', handler: WsCloseHandler): this;
    on(event: string, handler: any): this {
        if (event === 'message') this.messageHandlers.push(handler as WsMessageHandler);
        else if (event === 'close') this.closeHandlers.push(handler as WsCloseHandler);
        return this;
    }

    emit(event: 'message', data: ArrayBuffer | string, isBinary: boolean): void;
    emit(event: 'close', code: number, message: ArrayBuffer): void;
    emit(event: string, ...args: any[]): void {
        if (event === 'message') {
            this.messageHandlers.forEach(h => h(args[0], args[1]));
        } else if (event === 'close') {
            this.closeHandlers.forEach(h => h(args[0], args[1]));
        }
    }

    send(data: string | ArrayBuffer): void {
        const isBinary = typeof data !== 'string';
        this.ws.send(data, isBinary);
    }

    close(code?: number, reason?: string): void {
        this.ws.end(code ?? 1000, reason ? Buffer.from(reason) : undefined);
    }
}

const HyperExpressLike = { Server, Router };

export { Server, Router, Request, Response, RequestContext, WSWrapper };
export default HyperExpressLike;
