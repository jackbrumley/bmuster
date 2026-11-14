import { newRecoveryCodesRequestSchema } from '#lib/schemas/auth/two-factor.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { replaceRecoveryCodes } from '#lib/server/services/auth/two-factor.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/account/two-factor/recovery-codes: a new set for a current code (TF12). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = newRecoveryCodesRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = replaceRecoveryCodes(
		database,
		env.secretsKey,
		user,
		parsed.data,
		event.getClientAddress(),
		Date.now()
	);
	return result.kind === 'replaced'
		? Response.json({ recoveryCodes: result.recoveryCodes })
		: Response.json({ message: result.message }, { status: result.status });
});
