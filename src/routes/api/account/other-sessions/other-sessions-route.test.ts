import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { otherSessionsEndedReplySchema } from '#lib/schemas/auth/sessions.ts';
import { database } from '#lib/server/database/app-database.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { findSession, SESSION_COOKIE, startSession } from '#lib/server/services/auth/sessions.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { DELETE } from './+server.ts';

type Who = { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };

const CLIENT = { ip: '192.0.2.1', userAgent: 'Vitest' };

async function remove(who: Who, token: string | undefined): Promise<Response> {
	const url = new URL('https://bmuster.test/api/account/other-sessions');
	const cookies: Pick<RequestEvent['cookies'], 'get'> = {
		get: (name) => (name === SESSION_COOKIE ? token : undefined)
	};
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> & {
		cookies: Pick<RequestEvent['cookies'], 'get'>;
	} = {
		locals: { session: who },
		url,
		cookies,
		request: new Request(url, { method: 'DELETE' })
	};
	return DELETE(partial as Parameters<typeof DELETE>[0]);
}

async function person(): Promise<ConsoleUser> {
	return toConsoleUser(
		await addTestUser(database, {
			email: `sessions-${crypto.randomUUID()}@example.com`,
			role: 'member',
			password: null
		})
	);
}

describe('DELETE /api/account/other-sessions (SPEC-SIGN-IN S21)', () => {
	it('S21: refuses anyone signed out (401)', async () => {
		expect((await remove({ kind: 'none' }, undefined)).status).toBe(401);
	});

	it("S21: ends the person's other console sessions, keeps this one, and is audited", async () => {
		const user = await person();
		const now = Date.now();
		const here = startSession(database, user.id, CLIENT, now);
		const elsewhere = startSession(database, user.id, CLIENT, now);
		const response = await remove({ kind: 'signed-in', user }, here.token);
		expect(response.status).toBe(200);
		expect(otherSessionsEndedReplySchema.parse(await response.json())).toEqual({ ended: 1 });
		expect(findSession(database, here.token, Date.now()).kind).toBe('active');
		expect(findSession(database, elsewhere.token, Date.now()).kind).toBe('none');
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'sign-out',
			actorUserId: user.id,
			detail: { sessions: 'every other session', ended: '1' }
		});
	});
});
