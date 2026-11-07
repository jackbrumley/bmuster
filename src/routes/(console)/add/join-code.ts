import { createJoinCodeReplySchema } from '#lib/schemas/machines/join-codes.ts';
import { apiRequest } from '#lib/utils/api-client.ts';

/** A join code on Add machine: the single-use one, or a roll-out code (SPEC-ENROLMENT 5, 13). */
export type CodeState =
	| { kind: 'none' }
	| { kind: 'making' }
	| { kind: 'ready'; id: string; code: string; expiresAtIso: string; maxUses: number }
	| { kind: 'failed'; message: string };

/** Makes a code; machines that join with it go into `machineGroupIds` (SPEC-ACCESS A7). */
export async function makeJoinCode(
	maxUses: number,
	minutes: number,
	machineGroupIds: readonly string[]
): Promise<CodeState> {
	const result = await apiRequest({
		method: 'POST',
		url: '/api/join-codes',
		body: { maxUses, minutes, machineGroupIds },
		reply: createJoinCodeReplySchema
	});
	return result.ok
		? {
				kind: 'ready',
				id: result.data.id,
				code: result.data.code,
				expiresAtIso: result.data.expiresAtIso,
				maxUses: result.data.maxUses
			}
		: { kind: 'failed', message: result.message };
}
