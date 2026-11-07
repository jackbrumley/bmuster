import { updateProviderRequestSchema } from '#lib/schemas/auth/identity-providers.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { deleteProvider, updateProvider } from '#lib/server/services/auth/identity-providers.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

const NOT_FOUND = { message: 'No sign-in provider with this id.' };

/** PATCH /api/identity-providers/<id>: change a provider; the secret is kept unless replaced. */
export const PATCH: RequestHandler = route.admin(async ({ request, params }, { user }) => {
	const parsed = updateProviderRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const provider = updateProvider(
		database,
		user.id,
		params.id,
		parsed.data,
		env.secretsKey,
		Date.now()
	);
	return provider === undefined
		? Response.json(NOT_FOUND, { status: 404 })
		: Response.json({ provider });
});

/** DELETE /api/identity-providers/<id>: people linked through it keep their accounts. */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) =>
	deleteProvider(database, user.id, params.id, Date.now())
		? Response.json({ deleted: true })
		: Response.json(NOT_FOUND, { status: 404 })
);
