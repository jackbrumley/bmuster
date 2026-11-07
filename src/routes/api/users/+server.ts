import { createUserRequestSchema } from '#lib/schemas/users/users.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { addUser, listUsers } from '#lib/server/services/users/users.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/users: everyone who can sign in (admins). */
export const GET: RequestHandler = route.admin(() => Response.json({ users: listUsers(database) }));

/** POST /api/users: add (invite) someone (SPEC-SIGN-IN S12). */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = createUserRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const { password, ...rest } = parsed.data;
	const result = await addUser(
		database,
		user.id,
		{ ...rest, password: password.kind === 'set' ? password.value : null },
		Date.now()
	);
	return result.kind === 'done'
		? Response.json({ user: result.user }, { status: 201 })
		: Response.json({ message: result.message }, { status: result.status });
});
