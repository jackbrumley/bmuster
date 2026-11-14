import { turnOffRequestSchema, turnOnRequestSchema } from '#lib/schemas/auth/two-factor.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { confirmTotpSetUp, turnOffTwoFactor } from '#lib/server/services/auth/two-factor.ts';
import { findUserById } from '#lib/server/services/users/users.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/account/two-factor: turn it on with the first code and the password (TF3). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = turnOnRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const row = findUserById(database, user.id);
	if (row === undefined) {
		return Response.json({ message: 'No user with this id.' }, { status: 404 });
	}
	const result = await confirmTotpSetUp(
		database,
		env.secretsKey,
		row,
		{ code: parsed.data.code, password: { kind: 'given', password: parsed.data.password } },
		{ ip: event.getClientAddress(), where: 'account' },
		Date.now()
	);
	return result.kind === 'on'
		? Response.json({ recoveryCodes: result.recoveryCodes })
		: Response.json({ message: result.message }, { status: result.status });
});

/** DELETE /api/account/two-factor: turn it off with the password and a code (TF11). */
export const DELETE: RequestHandler = route.user(async (event, { user }) => {
	const parsed = turnOffRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const row = findUserById(database, user.id);
	if (row === undefined) {
		return Response.json({ message: 'No user with this id.' }, { status: 404 });
	}
	const result = await turnOffTwoFactor(
		database,
		env.secretsKey,
		row,
		parsed.data,
		event.getClientAddress(),
		Date.now()
	);
	return result.kind === 'off'
		? Response.json({ turnedOff: true })
		: Response.json({ message: result.message }, { status: result.status });
});
