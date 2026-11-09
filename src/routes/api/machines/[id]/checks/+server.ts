import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendToAgent } from '#lib/server/services/agents/live-agents.ts';
import { requestChecks } from '#lib/server/services/logs/machine-checks.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/checks: the agent runs its fixed self-checks now and sends the results
 * (SPEC-DIAGNOSTICS 1). Admins only (diagnostics tokens never reach it); once a minute per
 * machine; audited. The request carries nothing: what the checks do is fixed in the agent.
 */
export const POST: RequestHandler = route.admin(({ params }, { user }) => {
	const result = requestChecks(
		database,
		params.id,
		user.id,
		(message) => sendToAgent(params.id, message),
		Date.now()
	);
	switch (result.kind) {
		case 'not-found':
			return error(404, 'No machine with this id');
		case 'too-soon':
			return error(
				429,
				`Checks were asked for less than a minute ago; try again in ${result.waitSeconds} s.`
			);
		case 'offline':
			return error(409, 'The machine is offline, so it cannot run its checks now.');
		case 'requested':
			return Response.json({ requested: true });
	}
});
