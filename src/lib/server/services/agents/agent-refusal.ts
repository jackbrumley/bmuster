import type { RefusalReason } from '#lib/schemas/agents/agent-protocol.ts';

/** Why the server refused an agent (SPEC-ENROLMENT 6.1); sent as `{ reason, message }`. */
export type AgentRefusal = {
	refused: true;
	reason: RefusalReason;
	status: 400 | 401 | 404 | 409;
	message: string;
};

export function refuse(reason: RefusalReason, message: string): AgentRefusal {
	return { refused: true, reason, status: statusFor(reason), message };
}

function statusFor(reason: RefusalReason): AgentRefusal['status'] {
	switch (reason) {
		case 'bad-request':
			return 400;
		case 'invalid-code':
		case 'unknown-machine':
			return 404;
		case 'expired-code':
		case 'used-code':
			return 409;
		case 'bad-signature':
		case 'stale-timestamp':
		case 'replayed-timestamp':
		case 'revoked':
			return 401;
	}
}

export function isRefusal(value: unknown): value is AgentRefusal {
	return (
		typeof value === 'object' && value !== null && 'refused' in value && value.refused === true
	);
}

export function refusalResponse(refusal: AgentRefusal): Response {
	return Response.json(
		{ reason: refusal.reason, message: refusal.message },
		{ status: refusal.status }
	);
}
