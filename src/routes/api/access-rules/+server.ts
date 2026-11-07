import { accessRuleRequestSchema } from '#lib/schemas/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { createRule } from '#lib/server/services/access/rules.ts';
import { changeReply } from '../groups.server.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/access-rules: add a rule (admins; SPEC-ACCESS A4). */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = accessRuleRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return changeReply(createRule(database, user.id, parsed.data, Date.now()), true);
});
