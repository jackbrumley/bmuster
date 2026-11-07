import { error } from '@sveltejs/kit';
import { env } from '#lib/server/env.ts';
import { isAgentTarget, latestRelease } from '#lib/server/services/agents/releases.ts';
import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/** GET /agent/v1/releases/latest?target=…: the newest build's manifest. Public. */
export const GET: RequestHandler = route.public(({ url }) => {
	const target = url.searchParams.get('target') ?? '';
	if (!isAgentTarget(target)) {
		error(400, `Unknown target '${target}'`);
	}
	const manifest = latestRelease(env.releasesPath, target, url.origin);
	if (manifest === undefined) {
		error(404, `This server has no agent build for ${target}`);
	}
	return Response.json(manifest);
});
