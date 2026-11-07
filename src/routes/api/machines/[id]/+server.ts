import { error } from '@sveltejs/kit';
import { updateMachineDetailsRequestSchema } from '#lib/schemas/machines/machine-details.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { updateMachineDetails } from '#lib/server/services/machines/machine-details.ts';
import { removeMachine } from '#lib/server/services/machines/machine-views.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/machines/<id>: rename and describe a machine (SPEC-MACHINE-DETAILS D1, D2). Admins. */
export const PATCH: RequestHandler = route.admin(async ({ params, request }, { user }) => {
	const parsed = updateMachineDetailsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = updateMachineDetails(database, params.id, parsed.data, user.id, Date.now());
	if (result.kind === 'no-machine') {
		error(404, 'No machine with this id');
	}
	return Response.json({ name: result.name, description: result.description });
});

/** DELETE /api/machines/<id>: remove a machine; its agent is refused from now on (SPEC-ENROLMENT 9). Admins. */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	if (!removeMachine(database, params.id, user.id, Date.now())) {
		error(404, 'No machine with this id');
	}
	return Response.json({ removed: true });
});
