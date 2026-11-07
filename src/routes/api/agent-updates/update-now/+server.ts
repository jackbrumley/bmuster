import { updateNowRequestSchema } from '#lib/schemas/machines/agent-updates.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { requestUpdates } from '#lib/server/services/agents/agent-updates.ts';
import { askForCheckIn } from '#lib/server/services/agents/live-agents.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { activeMachineNames } from '#lib/server/services/machines/machine-views.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/agent-updates/update-now (SPEC-AGENT-UPDATES): admins; audited per machine. Connected
 * agents are asked to check in at once, so they take the update now rather than at their next
 * check-in.
 */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = updateNowRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const ids =
		parsed.data.machines.kind === 'all'
			? [...activeMachineNames(database).keys()]
			: parsed.data.machines.ids;
	const result = requestUpdates(
		database,
		ids,
		signedReleases(env.releasesPath),
		user.id,
		Date.now()
	);
	for (const machineId of result.requested) {
		askForCheckIn(machineId);
	}
	return Response.json({ requested: result.requested.length, skipped: result.skipped });
});
