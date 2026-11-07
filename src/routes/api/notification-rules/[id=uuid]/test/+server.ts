import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { wakeEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { sendTestNotification } from '#lib/server/services/notifications/notify.ts';
import type { RequestHandler } from './$types';

/** POST /api/notification-rules/<id>/test: a test notification to the rule's recipients (SPEC-EMAIL E6). */
export const POST: RequestHandler = route.admin(({ params }, { user }) => {
	const result = sendTestNotification(database, user, params.id, Date.now());
	if (result.kind === 'refused') {
		return Response.json({ message: result.message }, { status: result.status });
	}
	wakeEmailWorker();
	return Response.json({ recipients: result.recipients });
});
