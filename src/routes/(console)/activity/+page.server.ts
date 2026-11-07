import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { activityScopeFor } from '#lib/server/services/access/access.ts';
import { activityFeed } from '#lib/server/services/users/activity-feed.ts';
import type { PageServerLoad } from './$types';

/**
 * The newest audit entries (SPEC-SIGN-IN S13). Admins see everything; a
 * member sees only entries about machines they can see (SPEC-ACCESS A6).
 */
export const load: PageServerLoad = page.user((_event, { user }) => ({
	now: Date.now(),
	entries: activityFeed(database, activityScopeFor(database, user), 200)
}));
