import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { revokeDiagnosticsToken } from '#lib/server/services/auth/diagnostics-tokens.ts';
import type { RequestHandler } from './$types';

/** DELETE /api/diagnostics-tokens/<id>: revoke a token at once (SPEC-AGENT-LOGS 4). Admins; audited. */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	switch (revokeDiagnosticsToken(database, params.id, user.id, Date.now())) {
		case 'revoked':
			return Response.json({ revoked: true });
		case 'not-found':
			return Response.json({ message: 'No diagnostics token with this id.' }, { status: 404 });
		case 'already-ended':
			return Response.json(
				{ message: 'This token has already expired or been revoked.' },
				{ status: 409 }
			);
	}
});
