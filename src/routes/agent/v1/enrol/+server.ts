import { enrolRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { isRefusal, refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { enrolMachine } from '#lib/server/services/agents/enrolment.ts';
import { serverKey } from '#lib/server/services/agents/server-keys.ts';
import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/** POST /agent/v1/enrol: a machine joins with a join code (SPEC-ENROLMENT 4); the code is its credential. */
export const POST: RequestHandler = route.public(async ({ request }) => {
	const parsed = enrolRequestSchema.safeParse(await request.json());
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The enrolment request is not valid.'));
	}
	const now = Date.now();
	const key = serverKey(database, env.secretsKey, now);
	const result = enrolMachine(database, parsed.data, key.publicKeyBase64, now);
	return isRefusal(result) ? refusalResponse(result) : Response.json(result);
});
