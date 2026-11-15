import { route } from '#lib/server/guards/route.ts';
import { listTransfers } from '#lib/server/services/sessions/session-files.ts';
import { sessionFilesContext } from '../session-files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/session-files/transfers: this person's transfers here in the last hour (SPEC-SESSION-FILES 3.3). */
export const GET: RequestHandler = route.user((event, { user }) => {
	const listed = listTransfers(sessionFilesContext(event, user));
	return listed.kind === 'ok'
		? Response.json({ transfers: listed.value })
		: Response.json({ message: listed.message }, { status: listed.status });
});
