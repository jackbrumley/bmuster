import { dev, building } from '$app/env';
import { sequence } from '@sveltejs/kit/hooks';
import type { HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
// Opening the database applies migrations before the first request.
import { startUpdateChecks } from '#lib/server/services/server-updates/live.ts';
import { startTestChannelChecks } from '#lib/server/services/agents/test-builds-live.ts';
import { database } from '#lib/server/database/app-database.ts';
import { scheduleSnapshots } from '#lib/server/database/snapshots.ts';
import { env } from '#lib/server/env.ts';
import { errorReference, serverErrorHandler } from '#lib/server/hooks/handle-error.ts';
import { originCheck } from '#lib/server/hooks/origin-check.ts';
import { session } from '#lib/server/hooks/session.ts';
import { setupRedirect } from '#lib/server/hooks/setup-redirect.ts';
import {
	lanCertificateNames,
	startupServedCertificate
} from '#lib/server/services/agents/local-tls.ts';
import { restorePresence } from '#lib/server/services/agents/presence.ts';
import { applyFirstRunLocalNetworkMode, prepareFirstRun } from '#lib/server/services/auth/setup.ts';
import { startEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { serverSetupCode } from '#lib/server/services/auth/setup-code.ts';
import { scheduleLogRetention } from '#lib/server/services/logs/log-retention.ts';
import {
	serverLog,
	serverLogWriter,
	storeServerLogs
} from '#lib/server/services/logs/server-log.ts';
import {
	closeRunsCutByRestart,
	scheduleCommandOutputRetention
} from '#lib/server/services/commands/command-retention.ts';
import { closeSessionsCutByRestart } from '#lib/server/services/sessions/session-audit.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { scheduleShareLinkSweeps } from '#lib/server/services/share-links/share-links.ts';
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
 * (SPEC-EMAIL E3); machines whose live socket was open when the server
 * stopped get a grace period to reconnect (SPEC-PRESENCE P4), and sessions the
 * stop cut off are recorded as ended (SPEC-SESSIONS T9), as are command runs, whose output
 * is deleted after 30 days (SPEC-COMMANDS C16); share links that
 * run out end every 10 seconds (SPEC-SHARE-LINKS D7). The server's
 * own log records are kept from the start, and old agent and server log
 * records are pruned now and hourly (SPEC-AGENT-LOGS 2). The dev
 * server registers Vite's own certificate. A built server also schedules the nightly database snapshot (SPEC-HOSTING
 * H3); the dev server does not, so it never writes backups beside a
 * developer's database.
 */
export const init: ServerInit = async () => {
	storeServerLogs(database, crypto.randomUUID());
	scheduleLogRetention(database);
	registerSocketRoutes(SOCKET_ROUTES);
	applyFirstRunLocalNetworkMode(database, env.localNetworkModeAtFirstRun, Date.now());
	if (!dev) {
		registerServedCertificate(
			startupServedCertificate(database, env.secretsKey, lanCertificateNames(), Date.now())
		);
	}
	await prepareFirstRun(
		database,
		env.firstAdmin,
		serverSetupCode,
		serverLogWriter('auth'),
		Date.now()
	);
	if (!dev && env.databasePath !== ':memory:') {
		scheduleSnapshots(
			database.$client,
			env.databasePath,
			env.backupSchedule,
			serverLogWriter('database')
		);
	}
	if (!dev && !building) {
		startUpdateChecks(serverLogWriter('updates'));
		startTestChannelChecks(serverLogWriter('updates'));
	}
	startEmailWorker(database, env.secretsKey);
	restorePresence(database, Date.now());
	const relay = sessionRelay();
	// Share links that run out end, with their sessions (SPEC-SHARE-LINKS D7).
	scheduleShareLinkSweeps(database, relay, (caught) => {
		serverLog('error', 'sessions', `Share link sweep failed: ${String(caught)}`);
	});
	const closed = closeSessionsCutByRestart(
		database,
		(sessionId) => relay.isRunning(sessionId),
		Date.now()
	);
	if (closed > 0) {
		serverLog(
			'info',
			'sessions',
			`Recorded ${closed === 1 ? 'a session' : `${closed} sessions`} cut off by the restart as ended.`
		);
	}
	// Command runs live in memory: one the restart cut off ends now (SPEC-COMMANDS C16).
	const runs = closeRunsCutByRestart(database, Date.now());
	if (runs > 0) {
		serverLog(
			'info',
			'sessions',
			`Closed ${runs === 1 ? 'a command run' : `${runs} command runs`} cut off by the restart.`
		);
	}
	scheduleCommandOutputRetention(database);
};

/**
 * Every request: who is signed in → first-run setup → cross-site writes
 * refused. Access itself is checked by the guard on each route.
 */
export const handle = sequence(session, setupRedirect, originCheck);

/**
 * Unexpected errors go to the server log under a reference the error page
 * shows (SPEC-ERROR-PAGES E5); the browser never sees the error itself.
 */
export const handleError: HandleServerError = serverErrorHandler((line) => {
	serverLog('error', 'http', line);
}, errorReference);
