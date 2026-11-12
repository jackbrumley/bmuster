import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { openGuestDesktop } from '#lib/server/services/share-links/guest-sessions.ts';
import { guestSessionRequestSchema } from '#lib/schemas/share-links/share-links.ts';
import { invalidRequest, readJson } from '../../../api/replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /s/<token>/session: the guest watches or controls the link's machine
 * (SPEC-SHARE-LINKS SL11–SL13). The ticket carries the link's permissions
 * only and always asks the person at the screen first.
 */
export const POST: RequestHandler = route.guest(async (event, { grant }) => {
	const parsed = guestSessionRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = openGuestDesktop(
		database,
		sessionRelay(),
		env.secretsKey,
		grant,
		parsed.data.mode,
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
