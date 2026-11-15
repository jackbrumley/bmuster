import { cleanupApproveRequestSchema } from '#lib/schemas/storage/cleanup.ts';
import { route } from '#lib/server/guards/route.ts';
import { approveCleanupRequest } from '#lib/server/services/sessions/cleanup-requests.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { cleanupDeciderContext } from '../../cleanup-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/approvals/clean-ups/<id>/approve (SPEC-MCP M54): approves an AI assistant's clean-up
 * of BMuster's safe items. Security work: only from a console session (the origin hook checks it
 * came from this console; an MCP token is refused here), with `files` on the machine and a
 * recent sign-in, all checked in the service. It then starts on the approver's files session.
 */
export const POST: RequestHandler = route.user(async (event, session) => {
	const parsed = cleanupApproveRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const approved = await approveCleanupRequest(
		cleanupDeciderContext(event, session),
		event.params.id,
		parsed.data.recheck
	);
	return approved.kind === 'approved'
		? Response.json({ requestId: approved.requestId })
		: Response.json({ message: approved.message }, { status: approved.status });
});
