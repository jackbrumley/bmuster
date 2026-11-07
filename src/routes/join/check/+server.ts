import {
	joinCheckRequestSchema,
	type JoinCheckReply
} from '#lib/schemas/machines/support-codes.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { checkSupportCode } from '#lib/server/services/agents/support-codes.ts';
import { invalidRequest, readJson } from '../../api/replies.server.ts';
import { joinRefusal } from '../join-replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /join/check: public. A typed support code → who gets access, or
 * "connected" once the machine has joined (the page polls this). Anything
 * else is one fixed refusal (SPEC-JOIN J2, J5, J6).
 */
export const POST: RequestHandler = route.public(async (event) => {
	const parsed = joinCheckRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	const result = checkSupportCode(
		database,
		env.secretsKey,
		{ typed: parsed.data.code, address: event.getClientAddress() },
		event.url.hostname,
		now
	);
	switch (result.kind) {
		case 'wrong':
		case 'paused':
			return joinRefusal(result, now);
		case 'open': {
			const reply: JoinCheckReply = {
				kind: 'open',
				supportPerson: result.supportPerson,
				organisation: result.organisation,
				expiresAtIso: result.expiresAt.toISOString(),
				scamWording: result.scamWording
			};
			return Response.json(reply);
		}
		case 'connected': {
			const reply: JoinCheckReply = { kind: 'connected', supportPerson: result.supportPerson };
			return Response.json(reply);
		}
	}
});
