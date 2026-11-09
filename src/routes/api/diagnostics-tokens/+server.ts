import { createTokenRequestSchema } from '#lib/schemas/logs/logs.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	createDiagnosticsToken,
	listDiagnosticsTokens
} from '#lib/server/services/auth/diagnostics-tokens.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/diagnostics-tokens: every token, without its secret (SPEC-AGENT-LOGS 4). Admins. */
export const GET: RequestHandler = route.admin(() =>
	Response.json({ tokens: listDiagnosticsTokens(database, Date.now()) })
);

/** POST /api/diagnostics-tokens: a new read-only token, shown this once. Admins; audited. */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = createTokenRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const created = createDiagnosticsToken(
		database,
		{ name: parsed.data.name, days: parsed.data.days, userId: user.id },
		Date.now()
	);
	return Response.json(
		{ id: created.id, token: created.token, expiresIso: created.expiresAt.toISOString() },
		{ headers: { 'cache-control': 'no-store' } }
	);
});
