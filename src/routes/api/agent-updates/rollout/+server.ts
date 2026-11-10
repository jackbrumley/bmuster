import { error } from '@sveltejs/kit';
import { AGENT_TARGETS } from '#lib/domain/machines/agent-release.ts';
import { rolloutRequestSchema } from '#lib/schemas/machines/agent-updates.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { pauseRollout, resumeRollout } from '#lib/server/services/agents/agent-updates.ts';
import { newestVersion } from '#lib/server/services/agents/update-channels.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/agent-updates/rollout: pause or resume the newest version's roll-out. Admins; audited. */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = rolloutRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const newest = newestVersion(
		signedReleases(env.releasesPath, env.agentTestBuildsPath).full,
		AGENT_TARGETS
	);
	if (newest === undefined) {
		error(409, 'This server has no signed agent build to roll out.');
	}
	const now = Date.now();
	const changed =
		parsed.data.action === 'pause'
			? pauseRollout(database, newest.version, user.id, now)
			: resumeRollout(database, newest.version, user.id, now);
	return Response.json({ changed });
});
