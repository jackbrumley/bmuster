import { planRequestSchema } from '#lib/schemas/commands/commands.ts';
import { route } from '#lib/server/guards/route.ts';
import { planRun } from '#lib/server/services/commands/commands.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import { commandContext } from '../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/commands/plan: what Review shows for these machines (SPEC-COMMANDS C8): which run,
 * which are skipped and why, and whether a password is needed first (C10). Runs nothing.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = planRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const planned = planRun(commandContext(event, session), parsed.data.machineIds);
	return planned.kind === 'planned'
		? Response.json({ machines: planned.machines, signIn: planned.signIn })
		: Response.json({ message: planned.message }, { status: planned.status });
});
