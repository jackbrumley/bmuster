import { testEmailRequestSchema } from '#lib/schemas/email/email.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendSmtp } from '#lib/server/services/email/smtp.ts';
import { sendTestEmail } from '#lib/server/services/email/test-email.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/email/test: send a test email now with the saved settings
 * (SPEC-EMAIL E2). The reply carries the server's answer or the exact error.
 */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = testEmailRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = await sendTestEmail(
		database,
		{ userId: user.id, name: user.name },
		parsed.data.to,
		env.secretsKey,
		sendSmtp,
		() => Date.now()
	);
	return Response.json({ result });
});
