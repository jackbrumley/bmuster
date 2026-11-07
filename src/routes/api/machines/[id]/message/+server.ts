import { error } from '@sveltejs/kit';
import { userMessageRequestSchema } from '#lib/schemas/machines/user-message.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendToAgent } from '#lib/server/services/agents/live-agents.ts';
import {
	sendUserMessage,
	type UserMessageResult
} from '#lib/server/services/machines/user-message.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/message: a message box on the screen of a Windows machine. Admins, and
 * members with desktop control or a terminal there; audited with the text.
 */
export const POST: RequestHandler = route.user(async ({ params, request }, { user }) => {
	const parsed = userMessageRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = sendUserMessage(
		database,
		user,
		params.id,
		parsed.data.text,
		Date.now(),
		(message) => sendToAgent(params.id, message)
	);
	if (result.kind === 'sent') {
		return Response.json({ sent: true });
	}
	const [status, message] = refusal(result.kind);
	error(status, message);
});

function refusal(kind: Exclude<UserMessageResult['kind'], 'sent'>): [number, string] {
	switch (kind) {
		case 'not-found':
			return [404, 'No machine with this id'];
		case 'not-allowed':
			return [403, 'You need desktop control or a terminal on this machine to send a message.'];
		case 'unsupported':
			return [409, 'Messages to the screen work on Windows machines only for now.'];
		case 'offline':
			return [409, 'The machine is offline, so the message could not be shown.'];
	}
}
