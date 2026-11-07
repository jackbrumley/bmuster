import { sequence } from '@sveltejs/kit/hooks';
import type { ServerInit } from '@sveltejs/kit/hooks';
// Opening the database applies migrations before the first request.
import '#lib/server/database/app-database.ts';
import { originCheck } from '#lib/server/hooks/origin-check.ts';
import { session } from '#lib/server/hooks/session.ts';
import { setupRedirect } from '#lib/server/hooks/setup-redirect.ts';
import { registerSocketRoutes } from '#lib/server/sockets/socket-registry.ts';
import { SOCKET_ROUTES } from '#lib/server/sockets/socket-route-table.ts';

/**
 * Start-up: socket routes are handed to server.ts before the server takes
 * requests.
 */
export const init: ServerInit = () => {
	registerSocketRoutes(SOCKET_ROUTES);
};

/**
 * Every request: who is signed in → first-run setup → cross-site writes
 * refused. Access itself is checked by the guard on each route.
 */
export const handle = sequence(session, setupRedirect, originCheck);
