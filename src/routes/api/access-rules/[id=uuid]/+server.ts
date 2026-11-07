import { accessRuleRequestSchema } from '#lib/schemas/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { deleteRule, updateRule } from '#lib/server/services/access/rules.ts';
import { changeReply } from '../../groups.server.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/access-rules/<id>: change a rule's groups, permissions or consent (admins; A4). */
export const PATCH: RequestHandler = route.admin(async ({ request, params }, { user }) => {
	const parsed = accessRuleRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return changeReply(updateRule(database, user.id, params.id, parsed.data, Date.now()), false);
});

/** DELETE /api/access-rules/<id>: delete a rule (admins; A4). */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) =>
	changeReply(deleteRule(database, user.id, params.id, Date.now()), false)
);
