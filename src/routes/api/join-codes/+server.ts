import { error } from '@sveltejs/kit';
import { createJoinCodeRequestSchema } from '#lib/schemas/machines/join-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { areChosenMachineGroups } from '#lib/server/services/access/groups.ts';
import { createJoinCode } from '#lib/server/services/agents/join-codes.ts';
import type { RequestHandler } from './$types';

/** POST /api/join-codes: make a join code (admins), naming the groups machines join (SPEC-ACCESS A7). */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = createJoinCodeRequestSchema.safeParse(await request.json());
	if (!parsed.success) {
		error(400, 'Uses must be 1 to 100 and minutes 1 to 10080.');
	}
	if (!areChosenMachineGroups(database, parsed.data.machineGroupIds)) {
		error(404, 'One of the machine groups no longer exists. Reload the page and pick again.');
	}
	const created = createJoinCode(
		database,
		{
			maxUses: parsed.data.maxUses,
			minutes: parsed.data.minutes,
			machineGroupIds: parsed.data.machineGroupIds,
			createdBy: user.id
		},
		Date.now()
	);
	return Response.json({
		id: created.id,
		code: created.code,
		expiresAtIso: created.expiresAt.toISOString(),
		maxUses: created.maxUses
	});
});
