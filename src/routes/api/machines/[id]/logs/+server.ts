import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendToAgent } from '#lib/server/services/agents/live-agents.ts';
import { requestAgentDiagnostics } from '#lib/server/services/agents/diagnostics.ts';
import type { RequestHandler } from './$types';

/** Admin-only, on-demand diagnostics from the named machine; never persisted or cached. */
export const POST: RequestHandler = route.admin(async ({ params }, { user }) => {
	const result = await requestAgentDiagnostics(
		database,
		params.id,
		user.id,
		(message) => sendToAgent(params.id, message),
		Date.now()
	);
	switch (result.kind) {
		case 'not-found':
			return error(404, 'No machine with this id');
		case 'offline':
			return error(409, 'This machine is offline. It cannot send fresh diagnostics.');
		case 'timed-out':
			return error(504, 'The agent did not return diagnostics within 10 seconds.');
		case 'rate-limited':
			return error(429, 'Wait 10 seconds before requesting diagnostics again.');
		case 'received': {
			const { message } = result;
			return Response.json(
				{
					agentVersion: message.agentVersion,
					capturedAtIso: new Date(message.capturedAtMs).toISOString(),
					lines: message.lines,
					truncated: message.truncated,
					journal: message.journal
				},
				{ headers: { 'Cache-Control': 'no-store' } }
			);
		}
	}
});
