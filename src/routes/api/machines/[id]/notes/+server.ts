import { error } from '@sveltejs/kit';
import { noteRequestSchema } from '#lib/schemas/machines/machine-notes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { canSeeMachine } from '#lib/server/services/access/access.ts';
import { addNote, listNotes } from '#lib/server/services/machines/machine-notes.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/notes: the machine's notes, newest first (SPEC-MACHINE-DETAILS D3). */
export const GET: RequestHandler = route.user(({ params }, { user }) => {
	if (!canSeeMachine(database, user, params.id)) {
		error(404, 'No machine with this id');
	}
	return Response.json({ notes: listNotes(database, params.id, user) });
});

/** POST /api/machines/<id>/notes: anyone who can see the machine adds a note (D4). */
export const POST: RequestHandler = route.user(async ({ params, request }, { user }) => {
	if (!canSeeMachine(database, user, params.id)) {
		error(404, 'No machine with this id');
	}
	const parsed = noteRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const note = addNote(database, params.id, user, parsed.data.body, Date.now());
	if (note === undefined) {
		error(404, 'No machine with this id');
	}
	return Response.json({ note });
});
