import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { cancelSupportCode } from '#lib/server/services/agents/support-codes.ts';
import type { RequestHandler } from './$types';

/** DELETE /api/support-codes/<id>: cancel an open support code and its join code (SPEC-JOIN J3). */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	switch (cancelSupportCode(database, params.id, user.id, Date.now())) {
		case 'cancelled':
			return Response.json({ cancelled: true });
		case 'not-found':
			return Response.json({ message: 'No support code with this id.' }, { status: 404 });
		case 'not-open':
			return Response.json(
				{ message: 'This support code has already been used, cancelled or has expired.' },
				{ status: 409 }
			);
	}
});
