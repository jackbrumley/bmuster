import { sequence } from '@sveltejs/kit/hooks';
import type { ServerInit } from '@sveltejs/kit/hooks';
// Opening the database applies migrations before the first request.
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { originCheck } from '#lib/server/hooks/origin-check.ts';
import { session } from '#lib/server/hooks/session.ts';
import { setupRedirect } from '#lib/server/hooks/setup-redirect.ts';
import { prepareFirstRun } from '#lib/server/services/auth/setup.ts';
import { printToServerLog, serverSetupCode } from '#lib/server/services/auth/setup-code.ts';
import { registerSocketRoutes } from '#lib/server/sockets/socket-registry.ts';
import { SOCKET_ROUTES } from '#lib/server/sockets/socket-route-table.ts';

/**
 * Start-up: socket routes are handed to server.ts before the server takes
 * requests; on a server with no users the first admin is created from the
 * environment, or a setup code is printed (SPEC-SIGN-IN S17, S18).
 */
export const init: ServerInit = async () => {
	registerSocketRoutes(SOCKET_ROUTES);
	await prepareFirstRun(database, env.firstAdmin, serverSetupCode, printToServerLog, Date.now());
};

/**
 * Every request: who is signed in → first-run setup → cross-site writes
 * refused. Access itself is checked by the guard on each route.
 */
export const handle = sequence(session, setupRedirect, originCheck);
