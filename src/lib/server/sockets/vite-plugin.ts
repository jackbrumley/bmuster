import type { Plugin } from 'vite';
import { attachSocketRoutes } from './attach.ts';
import { isSocketRoute, type SocketRoute } from './socket-route.ts';

/**
 * Serves the socket routes from `vite dev` and `vite preview`. The route table
 * loads through Vite's SSR module graph, so it shares module instances (the
 * database, the live-agent registry) with the pages.
 */
export function webSockets(): Plugin {
	return {
		name: 'bmuster-web-sockets',
		configureServer(server) {
			if (server.config.mode === 'test' || server.httpServer === null) {
				return;
			}
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
