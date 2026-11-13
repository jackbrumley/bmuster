import type { RequestEvent } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import type { SessionContext } from '#lib/server/guards/checks.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { commandRunner, type CommandRunner } from '#lib/server/services/commands/command-runner.ts';
import type { CommandContext } from '#lib/server/services/commands/commands.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';

/** The server's command runner (SPEC-COMMANDS), on the server's database and relay. */
export function appRunner(): CommandRunner {
	return commandRunner({
		database,
		relay: sessionRelay(),
		secretsKey: env.secretsKey,
		clock: Date.now
	});
}

/** What the commands service needs from a signed-in request. */
export function commandContext(event: RequestEvent, { user }: SessionContext): CommandContext {
	return {
		database,
		runner: appRunner(),
		user,
		// The session hook already proved this cookie; the recent sign-in check reads its times.
		sessionToken: event.cookies.get(SESSION_COOKIE) ?? '',
		ip: event.getClientAddress(),
		now: Date.now()
	};
}
