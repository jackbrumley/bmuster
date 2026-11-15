import { denyRequestSchema } from '#lib/schemas/commands/approvals.ts';
import { route } from '#lib/server/guards/route.ts';
import { denyCleanupRequest } from '#lib/server/services/sessions/cleanup-requests.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { cleanupDeciderContext } from '../../cleanup-context.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/approvals/clean-ups/<id>/deny (SPEC-MCP M55): nothing is deleted; the assistant reads the note. */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = denyRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const denied = denyCleanupRequest(
		cleanupDeciderContext(event, session),
		event.params.id,
		parsed.data.note
	);
	return denied.kind === 'denied'
		? Response.json({ requestId: denied.requestId })
		: Response.json({ message: denied.message }, { status: denied.status });
});
