import { setUserGroupsRequestSchema } from '#lib/schemas/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { setGroupsOfMember } from '#lib/server/services/access/groups.ts';
import { changeReply, endGrantsNoLongerAllowed } from '../../../groups.server.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/users/<id>/groups: the person's groups, from the Users page (admins; SPEC-ACCESS A1). */
export const PATCH: RequestHandler = route.admin(async ({ request, params }, { user }) => {
	const parsed = setUserGroupsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	const reply = changeReply(
		setGroupsOfMember(database, 'user', user.id, params.id, parsed.data.userGroupIds, now),
		false
	);
	endGrantsNoLongerAllowed('user', now);
	return reply;
});
