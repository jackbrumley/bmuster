import { dev } from '$app/env';
import { sequence } from '@sveltejs/kit/hooks';
import type { ServerInit } from '@sveltejs/kit/hooks';
// Opening the database applies migrations before the first request.
import { database } from '#lib/server/database/app-database.ts';
import { scheduleSnapshots } from '#lib/server/database/snapshots.ts';
import { env } from '#lib/server/env.ts';
import { originCheck } from '#lib/server/hooks/origin-check.ts';
import { session } from '#lib/server/hooks/session.ts';
import { setupRedirect } from '#lib/server/hooks/setup-redirect.ts';
import {
	lanCertificateNames,
	startupServedCertificate
} from '#lib/server/services/agents/local-tls.ts';
import { applyFirstRunLocalNetworkMode, prepareFirstRun } from '#lib/server/services/auth/setup.ts';
import { startEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { printToServerLog, serverSetupCode } from '#lib/server/services/auth/setup-code.ts';
import { registerSocketRoutes } from '#lib/server/sockets/socket-registry.ts';
import { SOCKET_ROUTES } from '#lib/server/sockets/socket-route-table.ts';
import { registerServedCertificate } from '#lib/server/tls/served-certificate.ts';

/**
 * Start-up: socket routes and the certificate to serve (plain HTTP, or the
 * server's own in local network mode, SPEC-INSTALL-OPTIONS L4) are handed to
 * server.ts before the server takes requests; on a server with no users the
 * installer's local network mode default is applied first (SPEC-SERVER-INSTALL
 * I12), then the first admin is created from the environment, or a setup code
 * is printed (SPEC-SIGN-IN S17, S18); the email queue starts working
 * (SPEC-EMAIL E3). The dev server registers Vite's own certificate. A
 * built server also schedules the nightly database snapshot (SPEC-HOSTING
 * H3); the dev server does not, so it never writes backups beside a
 * developer's database.
 */
export const init: ServerInit = async () => {
	registerSocketRoutes(SOCKET_ROUTES);
	applyFirstRunLocalNetworkMode(database, env.localNetworkModeAtFirstRun, Date.now());
	if (!dev) {
		registerServedCertificate(
			startupServedCertificate(database, env.secretsKey, lanCertificateNames(), Date.now())
		);
	}
	await prepareFirstRun(database, env.firstAdmin, serverSetupCode, printToServerLog, Date.now());
	if (!dev && env.databasePath !== ':memory:') {
		scheduleSnapshots(database.$client, env.databasePath, env.backupSchedule, printToServerLog);
	}
	startEmailWorker(database, env.secretsKey);
};

/**
 * Every request: who is signed in → first-run setup → cross-site writes
 * refused. Access itself is checked by the guard on each route.
 */
export const handle = sequence(session, setupRedirect, originCheck);
