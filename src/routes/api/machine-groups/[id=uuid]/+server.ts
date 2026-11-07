import { route } from '#lib/server/guards/route.ts';
import { deleteGroupHandler, updateGroupHandler } from '../../groups.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/machine-groups/<id>: rename and describe, or set the members (admins; SPEC-ACCESS). */
export const PATCH: RequestHandler = route.admin(({ request, params }, context) =>
	updateGroupHandler('machine', request, params.id, context)
);

/** DELETE /api/machine-groups/<id>: delete the group and the rules that use it (A8). */
export const DELETE: RequestHandler = route.admin(({ params }, context) =>
	deleteGroupHandler('machine', params.id, context)
);
