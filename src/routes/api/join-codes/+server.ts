import { error } from '@sveltejs/kit';
import { createJoinCodeRequestSchema } from '#lib/schemas/machines/join-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { createJoinCode } from '#lib/server/services/agents/join-codes.ts';
import type { RequestHandler } from './$types';

/** POST /api/join-codes: make a join code (console; single admin until SPEC-SIGN-IN). */
export const POST: RequestHandler = async ({ request }) => {
	const parsed = createJoinCodeRequestSchema.safeParse(await request.json());
	if (!parsed.success) {
		error(400, 'Uses must be 1 to 100 and minutes 1 to 10080.');
	}
	const created = createJoinCode(
		database,
		{ maxUses: parsed.data.maxUses, minutes: parsed.data.minutes, machineGroupIds: [] },
		Date.now()
	);
	return Response.json({
		code: created.code,
		expiresAtIso: created.expiresAt.toISOString(),
		maxUses: created.maxUses
	});
};
