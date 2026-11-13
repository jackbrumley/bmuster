import { startRunRequestSchema } from '#lib/schemas/commands/commands.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { startRun } from '#lib/server/services/commands/commands.ts';
import { listRunsFor } from '#lib/server/services/commands/run-views.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import { commandContext } from '../command-context.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/commands/runs: the Commands tab (SPEC-COMMANDS C20), through the machines they can view. */
export const GET: RequestHandler = route.user((_event, { user }) =>
	Response.json({ runs: listRunsFor(database, user) })
);

/**
 * POST /api/commands/runs: starts a run (C7–C15). Security work: every machine is checked with
 * the access service, the typed count and a recent sign-in are checked here, not trusted.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = startRunRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const started = await startRun(commandContext(event, session), parsed.data);
	return started.kind === 'started'
		? Response.json({ runId: started.runId }, { status: 201 })
		: Response.json({ message: started.message }, { status: started.status });
});
