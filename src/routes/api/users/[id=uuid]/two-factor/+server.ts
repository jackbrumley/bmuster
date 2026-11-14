import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { resetTwoFactorByAdmin } from '#lib/server/services/auth/two-factor-reset.ts';
import type { RequestHandler } from './$types';

/** DELETE /api/users/<id>/two-factor: an admin resets another person's two-factor (TF14). */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	const result = resetTwoFactorByAdmin(database, user, params.id, Date.now());
	return result.kind === 'reset'
		? Response.json({ reset: true })
		: Response.json({ message: result.message }, { status: result.status });
});
