import { notificationRuleRequestSchema } from '#lib/schemas/notifications/notifications.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { createRule } from '#lib/server/services/notifications/notification-rules.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/notification-rules: a new notification rule (SPEC-EMAIL E6); audited. */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = notificationRuleRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = createRule(database, user.id, parsed.data, Date.now());
	return result.kind === 'done'
		? Response.json({ id: result.id }, { status: 201 })
		: Response.json({ message: result.message }, { status: result.status });
});
