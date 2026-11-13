import { route } from '#lib/server/guards/route.ts';
import { cancelRun } from '#lib/server/services/commands/commands.ts';
import { commandContext } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/commands/runs/<id>/cancel (SPEC-COMMANDS C17): machines not started yet are
 * cancelled; running ones finish. The person who started it or an admin; the page confirms first.
 */
export const POST: RequestHandler = route.user((event, session) => {
	const cancelled = cancelRun(commandContext(event, session), event.params.id);
	return cancelled.kind === 'cancelled'
		? Response.json({ cancelled: cancelled.notStarted })
		: Response.json({ message: cancelled.message }, { status: cancelled.status });
});
