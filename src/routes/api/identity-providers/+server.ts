import { createProviderRequestSchema } from '#lib/schemas/auth/identity-providers.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { addProvider, listProviders } from '#lib/server/services/auth/identity-providers.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/identity-providers: every provider, never a secret (admins). */
export const GET: RequestHandler = route.admin(() =>
	Response.json({ providers: listProviders(database) })
);

/** POST /api/identity-providers: add a provider (SPEC-SIGN-IN S9). */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = createProviderRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const provider = addProvider(database, user.id, parsed.data, env.secretsKey, Date.now());
	return Response.json({ provider }, { status: 201 });
});
