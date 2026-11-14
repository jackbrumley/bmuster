import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { appRunner } from '#lib/server/services/commands/app-runner.ts';
import { listApprovals } from '#lib/server/services/commands/approval-views.ts';
import type { PageServerLoad } from './$types';

/**
 * Approvals (SPEC-MCP M26): AI assistants' requests waiting for this person's decision, newest
 * first. Only requests the setting lets them decide, on machines they can see; each opens its
 * approval card.
 */
export const load: PageServerLoad = page.user(({ cookies }, { user }) => {
	const now = Date.now();
	return {
		now,
		requests: listApprovals({
			database,
			runner: appRunner(),
			user,
			sessionToken: cookies.get(SESSION_COOKIE) ?? '',
			now
		})
	};
});
