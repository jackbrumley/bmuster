import { savedRunRequestSchema } from '#lib/schemas/commands/saved-commands.ts';
import { route } from '#lib/server/guards/route.ts';
import { startSavedRun } from '#lib/server/services/commands/saved-command-runs.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { commandContext } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/commands/saved/<id>/runs: runs a saved command (SPEC-SAVED-COMMANDS SC12). Security
 * work: the command, every machine, every value, the count and a recent sign-in are checked here.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = savedRunRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const started = await startSavedRun(commandContext(event, session), event.params.id, parsed.data);
	return started.kind === 'started'
		? Response.json({ runId: started.runId }, { status: 201 })
		: Response.json({ message: started.message }, { status: started.status });
});
