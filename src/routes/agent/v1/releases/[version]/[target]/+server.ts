import { error } from '@sveltejs/kit';
import { env } from '#lib/server/env.ts';
import { isAgentTarget } from '#lib/domain/machines/agent-release.ts';
import { releaseFile } from '#lib/server/services/agents/releases.ts';
import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/** GET /agent/v1/releases/<version>/<target>: the agent binary. Public; it is not secret. */
export const GET: RequestHandler = route.public(({ params }) => {
	if (!isAgentTarget(params.target)) {
		error(400, `Unknown target '${params.target}'`);
	}
	const release = releaseFile(env.releasesPath, params.version, params.target);
	if (release === undefined) {
		error(404, 'No such agent build');
	}
	return new Response(release.body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(release.size),
			'content-disposition': `attachment; filename="${release.fileName}"`
		}
	});
});
