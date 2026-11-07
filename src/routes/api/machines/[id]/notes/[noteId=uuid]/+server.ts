import { error } from '@sveltejs/kit';
import { noteRequestSchema } from '#lib/schemas/machines/machine-notes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { canSeeMachine } from '#lib/server/services/access/access.ts';
import { deleteNote, editNote } from '#lib/server/services/machines/machine-notes.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/machines/<id>/notes/<noteId>: the author edits their note (SPEC-MACHINE-DETAILS D4). */
export const PATCH: RequestHandler = route.user(async ({ params, request }, { user }) => {
	if (!canSeeMachine(user, params.id)) {
		error(404, 'No note with this id');
	}
	const parsed = noteRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = editNote(database, params.id, params.noteId, user, parsed.data.body, Date.now());
	if (result.kind === 'not-found') {
		error(404, 'No note with this id');
	}
	if (result.kind === 'not-allowed') {
		error(403, 'Only the person who wrote a note can edit it.');
	}
	return Response.json({ note: result.value });
});

/** DELETE /api/machines/<id>/notes/<noteId>: the author or an admin deletes a note; audited (D4, D5). */
export const DELETE: RequestHandler = route.user(({ params }, { user }) => {
	if (!canSeeMachine(user, params.id)) {
		error(404, 'No note with this id');
	}
	const result = deleteNote(database, params.id, params.noteId, user, Date.now());
	if (result.kind === 'not-found') {
		error(404, 'No note with this id');
	}
	if (result.kind === 'not-allowed') {
		error(403, 'Only the person who wrote a note, or an admin, can delete it.');
	}
	return Response.json({ deleted: true });
});
