import { notificationRuleRequestSchema } from '#lib/schemas/notifications/notifications.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { deleteRule, updateRule } from '#lib/server/services/notifications/notification-rules.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PATCH /api/notification-rules/<id>: the whole rule, changed (SPEC-EMAIL E6); audited. */
export const PATCH: RequestHandler = route.admin(async ({ params, request }, { user }) => {
	const parsed = notificationRuleRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = updateRule(database, user.id, params.id, parsed.data, Date.now());
	return result.kind === 'done'
		? Response.json({ id: result.id })
		: Response.json({ message: result.message }, { status: result.status });
});

/** DELETE /api/notification-rules/<id>; audited. */
export const DELETE: RequestHandler = route.admin(({ params }, { user }) => {
	const result = deleteRule(database, user.id, params.id, Date.now());
	return result.kind === 'done'
		? Response.json({ id: result.id })
		: Response.json({ message: result.message }, { status: result.status });
});
