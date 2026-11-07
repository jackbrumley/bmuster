import { setMachineGroupsRequestSchema } from '#lib/schemas/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { setGroupsOfMember } from '#lib/server/services/access/groups.ts';
import { changeReply } from '../../../groups.server.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/machines/<id>/groups: the machine's groups, from its Manage tab (admins; SPEC-ACCESS A2). */
export const PATCH: RequestHandler = route.admin(async ({ request, params }, { user }) => {
	const parsed = setMachineGroupsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return changeReply(
		setGroupsOfMember(
			database,
			'machine',
			user.id,
			params.id,
			parsed.data.machineGroupIds,
			Date.now()
		),
		false
	);
});
