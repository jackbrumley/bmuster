import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { donateAnswerReplySchema } from '#lib/schemas/settings/donate-reminder.ts';
import { database } from '#lib/server/database/app-database.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { readDonateAnswer } from '#lib/server/services/settings/donate-reminder.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { POST } from './+server.ts';

type Who = { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };

async function post(who: Who, body: unknown): Promise<Response> {
	const url = new URL('https://bmuster.test/api/settings/donate-reminder');
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> = {
		locals: { session: who },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
	return POST(partial as Parameters<typeof POST>[0]);
}

async function person(role: 'admin' | 'member'): Promise<ConsoleUser> {
	return toConsoleUser(
		await addTestUser(database, {
			email: `donate-${crypto.randomUUID()}@example.com`,
			role,
			password: null
		})
	);
}

describe('POST /api/settings/donate-reminder (SPEC-DONATE D5)', () => {
	it('D5: refuses anyone signed out (401) and members (403), changing nothing', async () => {
		const member = await person('member');
		expect((await post({ kind: 'none' }, { answer: 'donated' })).status).toBe(401);
		expect((await post({ kind: 'signed-in', user: member }, { answer: 'donated' })).status).toBe(
			403
		);
		expect(readDonateAnswer(database)).toEqual({ kind: 'none' });
	});

	it('D5: refuses an answer it does not know (400)', async () => {
		const admin = await person('admin');
		expect((await post({ kind: 'signed-in', user: admin }, { answer: 'never' })).status).toBe(400);
		expect(readDonateAnswer(database)).toEqual({ kind: 'none' });
	});

	it('D5: stores an admin answer and audits who gave it', async () => {
		const admin = await person('admin');
		const response = await post({ kind: 'signed-in', user: admin }, { answer: 'not-now' });
		expect(response.status).toBe(200);
		expect(donateAnswerReplySchema.parse(await response.json())).toEqual({ answered: 'not-now' });
		expect(readDonateAnswer(database)).toMatchObject({ kind: 'not-now', donatedBefore: false });
		expect(listAudit(database, 1)[0]).toMatchObject({
			actorUserId: admin.id,
			kind: 'setting-changed',
			target: 'Donation reminder',
			detail: { to: 'not now' }
		});
	});
});
