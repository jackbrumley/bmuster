import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { openDesktopSession, openTerminalSession } from '#lib/server/services/sessions/sessions.ts';
import { openSessionRequestSchema } from '#lib/schemas/sessions/sessions.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/sessions: opens a terminal or a desktop on the
 * machine (SPEC-SESSIONS T2, T3; SPEC-DESKTOP R2, R3). Checks access, asks
 * the agent with a signed ticket, and replies with the session and a
 * ticket for the browser's socket.
 */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = openSessionRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const request = parsed.data;
	const open = { relay: sessionRelay(), ip: event.getClientAddress(), now: Date.now() };
	const result =
		request.kind === 'terminal'
			? openTerminalSession(
					database,
					open.relay,
					env.secretsKey,
					user,
					event.params.id,
					request,
					open.ip,
					open.now
				)
			: openDesktopSession(
					database,
					open.relay,
					env.secretsKey,
					user,
					event.params.id,
					request,
					open.ip,
					open.now
				);
	switch (result.kind) {
		case 'opened':
			return Response.json(result.reply);
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
