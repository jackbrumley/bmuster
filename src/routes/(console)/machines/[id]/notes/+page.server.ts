import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { canSeeMachine } from '#lib/server/services/access/access.ts';
import { listNotes } from '#lib/server/services/machines/machine-notes.ts';
import type { PageServerLoad } from './$types';

/** The Notes tab (SPEC-MACHINE-DETAILS D3): the machine's notes, newest first. */
export const load: PageServerLoad = page.user(({ params }, { user }) => {
	if (!canSeeMachine(database, user, params.id)) {
		error(404, 'No machine with this id');
	}
	return { notes: listNotes(database, params.id, user) };
});
