import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { route } from '#lib/server/guards/route.ts';
import { activeMachineBasics } from '#lib/server/services/machines/machine-views.ts';
import { downloadOffer } from '#lib/server/services/sessions/session-files-download.ts';
import { database } from '#lib/server/database/app-database.ts';
import { offerDownloadQuerySchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest } from '../../../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../../../session-files.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/machines/<id>/session-files/offers/<offerId>/download?desktopSessionId=: the copied
 * files, one as itself with Range, several as a streamed zip (SPEC-SESSION-FILES SF25). HEAD gives
 * the headers alone.
 */
async function download(
	event: RequestEvent<{ id: string; offerId: string }>,
	user: ConsoleUser,
	method: 'GET' | 'HEAD'
): Promise<Response> {
	const query = offerDownloadQuerySchema.safeParse({
		desktopSessionId: event.url.searchParams.get('desktopSessionId') ?? '',
		offerId: event.params.offerId
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	const machine = activeMachineBasics(database, event.params.id)?.name ?? 'Machine';
	const day = new Date().toISOString().slice(0, 10);
	const outcome = await downloadOffer(sessionFilesContext(event, user), {
		...query.data,
		method,
		range: event.request.headers.get('range'),
		ifRange: event.request.headers.get('if-range'),
		zipName: `${machine} files ${day}.zip`
	});
	return outcome.kind === 'ok' ? outcome.value : sessionFilesReply(outcome);
}

export const GET: RequestHandler = route.user((event, { user }) => download(event, user, 'GET'));

export const HEAD: RequestHandler = route.user((event, { user }) => download(event, user, 'HEAD'));
