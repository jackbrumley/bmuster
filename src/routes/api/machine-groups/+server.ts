import { route } from '#lib/server/guards/route.ts';
import { createGroupHandler } from '../groups.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machine-groups: make a group (admins; SPEC-ACCESS). */
export const POST: RequestHandler = route.admin(({ request }, context) =>
	createGroupHandler('machine', request, context)
);
