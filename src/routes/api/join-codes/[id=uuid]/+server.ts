import { error } from '@sveltejs/kit';
import type { JoinCodeStatusReply } from '#lib/schemas/machines/join-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { visibleMachineIds } from '#lib/server/services/access/access.ts';
import { joinCodeStatus } from '#lib/server/services/agents/join-codes.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/join-codes/<id>: a join code's uses and the machines that joined
 * with it (admins). Machines are listed only when the person may see them
 * (SPEC-ACCESS A6); removed ones stay, unlinked, for the record.
 */
export const GET: RequestHandler = route.admin(({ params }, { user }) => {
	const status = joinCodeStatus(database, params.id, Date.now());
	if (status === undefined) {
		error(404, 'No join code with this id');
	}
	const visible = visibleMachineIds(database, user);
	const reply: JoinCodeStatusReply = {
		maxUses: status.maxUses,
		uses: status.uses,
		expiresAtIso: status.expiresAt.toISOString(),
		state: status.state,
		machines: status.machines
			.filter((machine) => machine.removed || visible.has(machine.id))
			.map((machine) => ({
				id: machine.id,
				name: machine.name,
				enrolledAtIso: machine.enrolledAt.toISOString(),
				removed: machine.removed
			}))
	};
	return Response.json(reply);
});
