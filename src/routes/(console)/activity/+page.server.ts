import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { activityFeed } from '#lib/server/services/users/activity-feed.ts';
import type { PageServerLoad } from './$types';

/** The newest audit entries (SPEC-SIGN-IN S13); admins only. */
export const load: PageServerLoad = page.admin(() => ({
	now: Date.now(),
	entries: activityFeed(database, 200)
}));
