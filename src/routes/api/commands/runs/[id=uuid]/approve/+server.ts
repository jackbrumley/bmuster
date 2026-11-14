import { approveRequestSchema } from '#lib/schemas/commands/approvals.ts';
import { route } from '#lib/server/guards/route.ts';
import { approveRun } from '#lib/server/services/commands/assistant-runs.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { commandContext } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/commands/runs/<id>/approve (SPEC-MCP M18–M20): approves an AI assistant's request,
 * as asked or edited. Security work: only from a console session (the origin hook checks the
 * request came from this console; an MCP token is refused here), with `run-commands` on every
 * machine and a recent sign-in, all checked in the service.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = approveRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const approved = await approveRun(commandContext(event, session), event.params.id, parsed.data);
	return approved.kind === 'approved'
		? Response.json({ runId: approved.runId })
		: Response.json({ message: approved.message }, { status: approved.status });
});
