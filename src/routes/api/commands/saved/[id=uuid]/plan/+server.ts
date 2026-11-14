import { savedPlanRequestSchema } from '#lib/schemas/commands/saved-commands.ts';
import { route } from '#lib/server/guards/route.ts';
import { planSavedRun } from '#lib/server/services/commands/saved-command-runs.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { commandContext } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/commands/saved/<id>/plan: what Review shows (SPEC-SAVED-COMMANDS SC11): the exact
 * command for each system, the machines, and whether a password is needed. Runs nothing.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = savedPlanRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const planned = planSavedRun(commandContext(event, session), event.params.id, parsed.data);
	return planned.kind === 'planned'
		? Response.json({
				commands: planned.commands,
				machines: planned.machines,
				signIn: planned.signIn
			})
		: Response.json({ message: planned.message }, { status: planned.status });
});
