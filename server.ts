/**
 * Production entry point: the adapter-node handler on a Node HTTP server plus
 * the socket routes (`node build` cannot carry WebSockets). Listens on HOST
 * and PORT like adapter-node does. Normally plain HTTP with TLS in front (a
 * reverse proxy); in local network mode (SPEC-INSTALL-OPTIONS L4) HTTPS with
 * the server's own certificate. The mode is read once, at start-up.
 *
 * Before the app (and its migrations) loads, the server takes the lock on its
 * database (SPEC-HOSTING H2), so a second server on the same data waits until
 * the first has stopped. Nothing listens while it waits, so /healthz and
 * /readyz answer only once the lock is held and the migrations are applied.
 */
import { publishReady } from './src/lib/server/services/server-updates/readiness.ts';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { acquireDataLock } from './src/lib/server/database/data-lock.ts';
import { env } from './src/lib/server/env.ts';
import { attachSocketRoutes } from './src/lib/server/sockets/attach.ts';
import { registeredSocketRoutes } from './src/lib/server/sockets/socket-registry.ts';
import { servedCertificate } from './src/lib/server/tls/served-certificate.ts';

/**
 * Long enough for an orchestrator to stop the old server (its grace period,
 * then server.close below), short enough that a forgotten second server
 * fails visibly instead of waiting for ever.
 */
const LOCK_WAIT_MS = 120_000;

// Held until the process ends (the kernel releases it however that happens);
// this module keeps the reference, so the lock's connection is never collected.
const dataLock =
	env.databasePath === ':memory:'
		? undefined
		: await acquireDataLock(env.databasePath, {
				timeoutMs: LOCK_WAIT_MS,
				retryMs: 1_000,
				log: (line) => process.stdout.write(`${line}\n`)
			});

// Importing the handler runs the app's `init` hook, which registers the socket
// routes and the certificate to serve.
const handlerModule: unknown = await import(new URL('./build/handler.js', import.meta.url).href);
if (
	typeof handlerModule !== 'object' ||
	handlerModule === null ||
	!('handler' in handlerModule) ||
	typeof handlerModule.handler !== 'function'
) {
	throw new Error('build/handler.js has no handler; run npm run build first');
}
const handler = handlerModule.handler as RequestListener;

const host = process.env['HOST'] ?? '0.0.0.0';
const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);

const served = servedCertificate();
const server =
	served.kind === 'own'
		? createSecureServer({ cert: served.certificatePem, key: served.privateKeyPem }, handler)
		: createServer(handler);
attachSocketRoutes(server, () => Promise.resolve(registeredSocketRoutes()), 'refuse');
server.listen(port, host, () => {
	publishReady(env.launcher);
	const scheme = served.kind === 'own' ? 'https' : 'http';
	const note = served.kind === 'own' ? ' (local network mode: its own certificate)' : '';
	const lock = dataLock === undefined ? '' : `, holding ${dataLock.path}`;
	process.stdout.write(`BMuster listening on ${scheme}://${host}:${port}${note}${lock}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close();
		server.closeIdleConnections();
		setTimeout(() => {
			server.closeAllConnections();
			process.exit(0);
		}, 10_000).unref();
	});
}
