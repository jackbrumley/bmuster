import type { Plugin } from 'vite';
import { registerServedCertificate, type ServedCertificate } from '../tls/served-certificate.ts';
import { attachSocketRoutes } from './attach.ts';
import { isSocketRoute, type SocketRoute } from './socket-route.ts';

/**
 * Serves the socket routes from `vite dev` and `vite preview`. The route table
 * loads through Vite's SSR module graph, so it shares module instances (the
 * database, the live-agent registry) with the pages. Also registers the
 * certificate the dev server serves, so Add machine can show its pin.
 */
export function webSockets(): Plugin {
	return {
		name: 'bmuster-web-sockets',
		configureServer(server) {
			if (server.config.mode === 'test' || server.httpServer === null) {
				return;
			}
			registerServedCertificate(devCertificate(server.config.server.https?.cert));
			attachSocketRoutes(
				server.httpServer,
				async () => {
					const table: unknown = await server.ssrLoadModule(
						'/src/lib/server/sockets/socket-route-table.ts'
					);
					return routesFrom(table);
				},
				'ignore'
			);
		}
	};
}

function routesFrom(table: unknown): SocketRoute[] {
	if (
		typeof table !== 'object' ||
		table === null ||
		!('SOCKET_ROUTES' in table) ||
		!Array.isArray(table.SOCKET_ROUTES)
	) {
		throw new Error('socket-route-table.ts must export SOCKET_ROUTES');
	}
	return table.SOCKET_ROUTES.filter(isSocketRoute);
}

/** The certificate in Vite's `server.https.cert` (basic-ssl puts the key and the certificate in one PEM). */
function devCertificate(cert: unknown): ServedCertificate {
	const pem = typeof cert === 'string' ? cert : Buffer.isBuffer(cert) ? cert.toString('utf8') : '';
	const block = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/.exec(pem);
	return block === null ? { kind: 'plain' } : { kind: 'dev', certificatePem: `${block[0]}\n` };
}
