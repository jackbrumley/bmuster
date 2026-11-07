/**
 * Production entry point: the adapter-node handler on a Node HTTP server plus
 * the socket routes (`node build` cannot carry WebSockets). Listens on HOST
 * and PORT like adapter-node does. Normally plain HTTP with TLS in front (a
 * reverse proxy); in local network mode (SPEC-INSTALL-OPTIONS L4) HTTPS with
 * the server's own certificate. The mode is read once, at start-up.
 */
import { createServer, type RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { attachSocketRoutes } from './src/lib/server/sockets/attach.ts';
import { registeredSocketRoutes } from './src/lib/server/sockets/socket-registry.ts';
import { servedCertificate } from './src/lib/server/tls/served-certificate.ts';

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
	const scheme = served.kind === 'own' ? 'https' : 'http';
	const note = served.kind === 'own' ? ' (local network mode: its own certificate)' : '';
	process.stdout.write(`BMuster listening on ${scheme}://${host}:${port}${note}\n`);
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
