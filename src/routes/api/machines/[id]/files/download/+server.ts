import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { route } from '#lib/server/guards/route.ts';
import { downloadFile } from '#lib/server/services/sessions/files-download.ts';
import { filePathSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { filesContext, queryValue } from '../files.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/machines/<id>/files/download?path=: the file, streamed from the
 * machine with Range support (SPEC-FILES F5). HEAD gives the headers alone.
 */
async function download(
	event: RequestEvent<{ id: string }>,
	user: ConsoleUser,
	method: 'GET' | 'HEAD'
): Promise<Response> {
	const path = filePathSchema.safeParse(queryValue(event, 'path'));
	if (!path.success) {
		return invalidRequest(path.error);
	}
	const outcome = await downloadFile(filesContext(event, user), {
		path: path.data,
		method,
		range: event.request.headers.get('range'),
		ifRange: event.request.headers.get('if-range')
	});
	return outcome.kind === 'ok'
		? outcome.value
		: Response.json({ message: outcome.message }, { status: outcome.status });
}

export const GET: RequestHandler = route.user((event, { user }) => download(event, user, 'GET'));

export const HEAD: RequestHandler = route.user((event, { user }) => download(event, user, 'HEAD'));
