import { updateUserRequestSchema } from '#lib/schemas/users/users.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	disableUser,
	enableUser,
	setDetails,
	setPassword,
	setRole,
	type UserChange
} from '#lib/server/services/users/users.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/users/<id>: change name and email, role, disable, enable or set a password (SPEC-SIGN-IN S12). */
export const PATCH: RequestHandler = route.admin(async ({ request, params }, { user }) => {
	const parsed = updateUserRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	let result: UserChange;
	switch (parsed.data.action) {
		case 'set-details':
			result = setDetails(
				database,
				user.id,
				params.id,
				{ name: parsed.data.name, email: parsed.data.email },
				now
			);
			break;
		case 'set-role':
			result = setRole(database, user.id, params.id, parsed.data.role, now);
			break;
		case 'disable':
			result = disableUser(database, user.id, params.id, now);
			break;
		case 'enable':
			result = enableUser(database, user.id, params.id, now);
			break;
		case 'set-password':
			result = await setPassword(database, user.id, params.id, parsed.data.password, now);
			break;
	}
	return result.kind === 'done'
		? Response.json({ user: result.user })
		: Response.json({ message: result.message }, { status: result.status });
});
