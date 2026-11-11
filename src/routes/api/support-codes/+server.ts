import { error } from '@sveltejs/kit';
import { createSupportCodeRequestSchema } from '#lib/schemas/machines/support-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { areChosenMachineGroups } from '#lib/server/services/access/groups.ts';
import { createSupportCode } from '#lib/server/services/agents/support-codes.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/support-codes: create an enrolment code (admins), with Add machine's groups (SPEC-JOIN J1). */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = createSupportCodeRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	if (!areChosenMachineGroups(database, parsed.data.machineGroupIds)) {
		error(404, 'One of the machine groups no longer exists. Reload the page and pick again.');
	}
	const created = createSupportCode(
		database,
		env.secretsKey,
		{ machineGroupIds: parsed.data.machineGroupIds, createdBy: user.id },
		Date.now()
	);
	return Response.json({
		id: created.id,
		code: created.code,
		expiresAtIso: created.expiresAt.toISOString(),
		joinCodeId: created.joinCodeId
	});
});
