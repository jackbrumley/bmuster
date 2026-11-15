import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { cleanupApprovalView } from '#lib/server/services/sessions/cleanup-approval-views.ts';
import { filesChannels } from '#lib/server/services/sessions/files-channel.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import type { PageServerLoad } from './$types';

/**
 * An AI assistant's clean-up request (SPEC-MCP M54), as its approval card: only for people the
 * approvers setting lets decide it, who can see the machine; anyone else gets not found.
 */
export const load: PageServerLoad = page.user(({ params, cookies, getClientAddress }, { user }) => {
	const now = Date.now();
	const view = cleanupApprovalView(
		{
			database,
			relay: sessionRelay(),
			channels: filesChannels(),
			secretsKey: env.secretsKey,
			user,
			sessionToken: cookies.get(SESSION_COOKIE) ?? '',
			ip: getClientAddress(),
			now
		},
		params.id
	);
	if (view === undefined) {
		error(404, 'No clean-up request with this id.');
	}
	return { now, view };
});
