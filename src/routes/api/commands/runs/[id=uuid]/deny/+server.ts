import { denyRequestSchema } from '#lib/schemas/commands/approvals.ts';
import { route } from '#lib/server/guards/route.ts';
import { denyRun } from '#lib/server/services/commands/assistant-runs.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { commandContext } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/commands/runs/<id>/deny (SPEC-MCP M20): nothing runs; the assistant reads the note. */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = denyRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const denied = denyRun(commandContext(event, session), event.params.id, parsed.data.note);
	return denied.kind === 'denied'
		? Response.json({ runId: denied.runId })
		: Response.json({ message: denied.message }, { status: denied.status });
});
