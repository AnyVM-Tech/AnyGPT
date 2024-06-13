import { createRequestHandler } from '@remix-run/express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { installGlobals } from '@remix-run/node';
import compression from 'compression';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import dotenv from 'dotenv';

dotenv.config();
installGlobals();

const port = parseInt(process.env.PORT as string, 10);

const viteDevServer =
	process.env.NODE_ENV === 'production'
		? undefined
		: await import('vite').then(vite =>
				vite.createServer({
					server: { middlewareMode: true }
				})
			); // port 24678 is the default port for Vite's server cannot use same port as express

const remixHandler = createRequestHandler({
	build: viteDevServer
		? () => viteDevServer.ssrLoadModule('virtual:remix/server-build')
		: // eslint-disable-next-line
			// @ts-ignore
			// eslint-disable-next-line
			await import('./build/server/index.js')
});

const app = express();
app.use(compression());
app.disable('x-powered-by');
// handle asset requests
if (viteDevServer) {
	app.use(viteDevServer.middlewares);
} else {
	// Vite fingerprints its assets so we can cache forever.
	app.use(
		'/assets',
		express.static('build/client/assets', {
			immutable: true,
			maxAge: '1y'
		})
	);
}

app.use(express.static('build/client', { maxAge: '1h' }));

app.use(morgan('tiny'));

// handle SSR requests
app.all('*', remixHandler);
const server = createServer();
server.on('request', (req: Request, res: Response) => {
	app(req, res);
});

server.listen(port, () => {
	console.log(`Express server started on http://localhost:${port}`);
});
