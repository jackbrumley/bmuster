import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { endShareLink } from '#lib/server/services/share-links/share-links.ts';
import type { RequestHandler } from './$types';

/**
 * End now (SPEC-SHARE-LINKS SL7): the link stops and its open session ends
 * at once. Anyone who may share the link's machine may end it; the page
 * asks first with confirmAction.
 */
export const DELETE: RequestHandler = route.user(({ params }, { user }) => {
	const result = endShareLink(database, sessionRelay(), user, params.id, Date.now());
	switch (result.kind) {
		case 'ended':
			return Response.json({ ended: true });
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
