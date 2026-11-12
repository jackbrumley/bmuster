import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { openGuestDesktop } from '#lib/server/services/share-links/guest-sessions.ts';
import { guestSessionRequestSchema } from '#lib/schemas/share-links/share-links.ts';
import { invalidRequest, readJson } from '../../../api/replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /s/<token>/session: the guest watches or controls the link's machine
 * (SPEC-SHARE-LINKS SL11–SL13, SL20), as the name and company they typed.
 * The ticket carries the link's permissions only; the person at the screen
 * is not asked but always sees the guest connected (D1). The address comes
 * from the same helper as sign-in, so a proxy's header counts only as far
 * as the server is set to trust it (ADDRESS_HEADER, XFF_DEPTH).
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
		{
			mode: parsed.data.mode,
			identity: { name: parsed.data.name, company: parsed.data.company }
		},
		signInClient(event),
		Date.now()
	);
	switch (result.kind) {
		case 'opened':
			return Response.json(result.reply);
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
