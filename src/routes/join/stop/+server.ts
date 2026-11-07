import { joinStopRequestSchema } from '#lib/schemas/machines/support-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { recordScamStop } from '#lib/server/services/agents/support-codes.ts';
import { invalidRequest, readJson } from '../../api/replies.server.ts';
import { joinRefusal } from '../join-replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /join/stop: public. An unsafe answer in the scam check, recorded in Activity (SPEC-JOIN J8). */
export const POST: RequestHandler = route.public(async (event) => {
	const parsed = joinStopRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	const result = recordScamStop(
		database,
		env.secretsKey,
		{ typed: parsed.data.code, address: event.getClientAddress() },
		parsed.data.question,
		now
	);
	return result.kind === 'recorded' ? Response.json({ recorded: true }) : joinRefusal(result, now);
});
