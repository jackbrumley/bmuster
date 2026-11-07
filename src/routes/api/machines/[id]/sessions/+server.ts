import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { openTerminalSession } from '#lib/server/services/sessions/sessions.ts';
import { openSessionRequestSchema } from '#lib/schemas/sessions/sessions.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/sessions: opens a terminal on the machine
 * (SPEC-SESSIONS T2, T3). Checks access, asks the agent with a signed ticket,
 * and replies with the session and a ticket for the browser's socket.
 */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = openSessionRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = openTerminalSession(
		database,
		sessionRelay(),
		env.secretsKey,
		user,
		event.params.id,
		parsed.data,
		event.getClientAddress(),
		Date.now()
	);
	switch (result.kind) {
		case 'opened':
			return Response.json(result.reply);
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
