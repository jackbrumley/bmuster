import { donateAnswerRequestSchema } from '#lib/schemas/settings/donate-reminder.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { answerDonateReminder } from '#lib/server/services/settings/donate-reminder.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/settings/donate-reminder: an admin's "Not now" or "I've donated,
 * thank you" on the Machines page's reminder; audited (SPEC-DONATE D5).
 */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = donateAnswerRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	answerDonateReminder(database, user.id, parsed.data.answer, Date.now());
	return Response.json({ answered: parsed.data.answer });
});
