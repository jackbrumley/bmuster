import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { removeMachine } from '#lib/server/services/machines/machine-views.ts';
import type { RequestHandler } from './$types';

/** DELETE /api/machines/<id>: remove a machine; its agent is refused from now on (SPEC-ENROLMENT 9). Admins. */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	if (!removeMachine(database, params.id, user.id, Date.now())) {
		error(404, 'No machine with this id');
	}
	return Response.json({ removed: true });
});
