import type { RequestEvent } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import type { SessionContext } from '#lib/server/guards/checks.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import type { CleanupDeciderContext } from '#lib/server/services/sessions/cleanup-requests.ts';
import { filesChannels } from '#lib/server/services/sessions/files-channel.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';

/** What deciding an AI assistant's clean-up needs from a signed-in request (SPEC-MCP M54). */
export function cleanupDeciderContext(
	event: RequestEvent,
	{ user }: SessionContext
): CleanupDeciderContext {
	return {
		database,
		relay: sessionRelay(),
		channels: filesChannels(),
		secretsKey: env.secretsKey,
		user,
		// The session hook already proved this cookie; the recent sign-in check reads its times.
		sessionToken: event.cookies.get(SESSION_COOKIE) ?? '',
		ip: event.getClientAddress(),
		now: Date.now()
	};
}
