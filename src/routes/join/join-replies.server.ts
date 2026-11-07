import type { JoinRefusal } from '#lib/server/services/agents/support-codes.ts';

/** The one message for every wrong code, so /join never says whether a code existed (SPEC-JOIN J5). */
export const WRONG_CODE =
	'That code doesn’t work. Check the numbers, or ask your support person for a new one.';

/** 404 for a wrong code; 429 with Retry-After while the guessing limits pause (J4). */
export function joinRefusal(refusal: JoinRefusal, now: number): Response {
	switch (refusal.kind) {
		case 'wrong':
			return Response.json({ message: WRONG_CODE }, { status: 404 });
		case 'paused': {
			const seconds = Math.max(1, Math.ceil((refusal.untilMs - now) / 1000));
			return Response.json(
				{ message: `Too many wrong codes. Try again in ${waitText(seconds)}.` },
				{ status: 429, headers: { 'retry-after': String(seconds) } }
			);
		}
	}
}

function waitText(seconds: number): string {
	if (seconds < 60) {
		return seconds === 1 ? '1 second' : `${String(seconds)} seconds`;
	}
	const minutes = Math.ceil(seconds / 60);
	return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}
