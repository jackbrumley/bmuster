import type { ServerInit } from '@sveltejs/kit/hooks';
// Opening the database applies migrations before the first request.
import '#lib/server/database/app-database.ts';
import { registerSocketRoutes } from '#lib/server/sockets/socket-registry.ts';
import { SOCKET_ROUTES } from '#lib/server/sockets/socket-route-table.ts';

/**
 * Start-up: socket routes are handed to server.ts before the server takes
 * requests.
 */
export const init: ServerInit = () => {
	registerSocketRoutes(SOCKET_ROUTES);
};
