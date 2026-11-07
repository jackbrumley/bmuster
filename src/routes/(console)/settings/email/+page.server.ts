import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listRecentEmails } from '#lib/server/services/email/email-queue.ts';
import { emailReadiness, readEmailSettings } from '#lib/server/services/settings/email-settings.ts';
import type { PageServerLoad } from './$types';

/**
 * Settings → Email (SPEC-EMAIL E1–E3, E8): the SMTP settings (the password
 * only as set or not set), the test email, and the newest sent, waiting and
 * failed emails. Admins only.
 */
export const load: PageServerLoad = page.admin((_event, { user }) => ({
	now: Date.now(),
	me: { email: user.email },
	settings: readEmailSettings(database),
	readiness: emailReadiness(database),
	recent: listRecentEmails(database, 50)
}));
