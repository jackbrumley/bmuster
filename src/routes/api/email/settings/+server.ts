import { updateEmailSettingsRequestSchema } from '#lib/schemas/email/email.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { wakeEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { updateEmailSettings } from '#lib/server/services/settings/email-settings.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/email/settings: every email setting at once (SPEC-EMAIL E1);
 * each change is audited. The password is write-only: keep, replace or clear.
 */
export const PATCH: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = updateEmailSettingsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const settings = updateEmailSettings(database, user.id, parsed.data, env.secretsKey, Date.now());
	// Messages that waited while email was off can go now.
	wakeEmailWorker();
	return Response.json({ settings });
});
