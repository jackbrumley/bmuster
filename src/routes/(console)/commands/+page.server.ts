import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listRunsFor } from '#lib/server/services/commands/run-views.ts';
import type { PageServerLoad } from './$types';

/**
 * The Commands tab (SPEC-COMMANDS C20): runs newest first, each seen only through the machines
 * the person can view.
 */
export const load: PageServerLoad = page.user((_event, { user }) => ({
	now: Date.now(),
	runs: listRunsFor(database, user)
}));
