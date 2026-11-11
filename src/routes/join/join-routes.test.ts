import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { registerServedCertificate } from '#lib/server/tls/served-certificate.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { cancelSupportCode, createSupportCode } from '#lib/server/services/agents/support-codes.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { load } from './+page.server.ts';
import { POST as check } from './check/+server.ts';
import { POST as install } from './install/+server.ts';
import { POST as stop } from './stop/+server.ts';
import { WRONG_CODE } from './join-replies.server.ts';

/** Just enough of a request event for the public /join endpoints. */
function post<Path extends '/join/check' | '/join/install' | '/join/stop'>(
	path: Path,
	body: unknown,
	address: string
): RequestEvent<Record<string, never>, Path> {
	const url = new URL(`https://bmuster.test${path}`);
	const partial: Pick<RequestEvent, 'request' | 'url' | 'getClientAddress'> = {
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => address
	};
	return partial as RequestEvent<Record<string, never>, Path>;
}

async function liveCode(): Promise<{ id: string; code: string; adminId: string }> {
	const admin = await addTestUser(database, {
		email: `ada-${crypto.randomUUID()}@example.com`,
		role: 'admin',
		password: null
	});
	const created = createSupportCode(
		database,
		env.secretsKey,
		{ machineGroupIds: [], createdBy: admin.id },
		Date.now()
	);
	return { id: created.id, code: created.code, adminId: admin.id };
}

// The built server registers this at start-up (hooks.server.ts); plain HTTP behind a proxy.
registerServedCertificate({ kind: 'plain' });

const SAFE = { contacted: 'yes', money: 'no', virus: 'no' };

function wrongFor(code: string): string {
	return code === '000000' ? '000001' : '000000';
}

describe('/join exposes nothing without a valid code (SPEC-JOIN J5)', () => {
	it('loads only the organisation name', () => {
		const event: Pick<Parameters<typeof load>[0], 'url'> = {
			url: new URL('https://bmuster.test/join')
		};
		const loaded = load(event as Parameters<typeof load>[0]);
		expect(loaded).toEqual({ organisation: 'bmuster.test' });
	});

	it('answers every wrong code with the same 404 and nothing else', async () => {
		const live = await liveCode();
		const cancelled = await liveCode();
		expect(cancelSupportCode(database, cancelled.id, cancelled.adminId, Date.now())).toBe(
			'cancelled'
		);
		const tries = [
			check(post('/join/check', { code: wrongFor(live.code) }, '192.0.2.1')),
			check(post('/join/check', { code: cancelled.code }, '192.0.2.2')),
			check(post('/join/check', { code: 'not a code' }, '192.0.2.3')),
			install(post('/join/install', { code: wrongFor(live.code), answers: SAFE }, '192.0.2.4')),
			stop(post('/join/stop', { code: wrongFor(live.code), question: 'virus' }, '192.0.2.5'))
		];
		for (const attempt of tries) {
			const response = await attempt;
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ message: WRONG_CODE });
		}
	});

	it('gives a live code only who gets access, never the join code', async () => {
		const { code } = await liveCode();
		const response = await check(post('/join/check', { code }, '192.0.2.10'));
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(Object.keys(body as object).sort()).toEqual([
			'expiresAtIso',
			'kind',
			'organisation',
			'scamWording',
			'supportPerson'
		]);
		expect(body).toMatchObject({ kind: 'open', organisation: 'bmuster.test' });
	});

	it('pauses an address that keeps guessing, with Retry-After', async () => {
		const { code } = await liveCode();
		for (let index = 0; index < 3; index += 1) {
			expect(
				(await check(post('/join/check', { code: wrongFor(code) }, '192.0.2.20'))).status
			).toBe(404);
		}
		const paused = await check(post('/join/check', { code }, '192.0.2.20'));
		expect(paused.status).toBe(429);
		expect(paused.headers.get('retry-after')).toBe('5');
		expect(await paused.json()).toEqual({
			message: 'Too many wrong codes. Try again in 5 seconds.'
		});
	});
});

describe('/join gives out the command only after a safe scam check (SPEC-JOIN J7, J8)', () => {
	it('refuses unsafe or missing answers, then answers safe ones', async () => {
		const { code } = await liveCode();
		for (const answers of [{}, { ...SAFE, contacted: 'no' }, { ...SAFE, virus: 'yes' }]) {
			const refused = await install(post('/join/install', { code, answers }, '192.0.2.30'));
			expect(refused.status).toBe(403);
			expect(await refused.json()).toEqual({ message: 'Answer the three questions first.' });
		}
		const response = await install(post('/join/install', { code, answers: SAFE }, '192.0.2.30'));
		expect(response.status).toBe(200);
		// The test server has no agent builds, so neither OS is offered.
		expect(await response.json()).toEqual({ linux: { kind: 'none' }, windows: { kind: 'none' } });
	});

	it('records a stop in Activity', async () => {
		const { code } = await liveCode();
		const response = await stop(post('/join/stop', { code, question: 'contacted' }, '192.0.2.40'));
		expect(response.status).toBe(200);
		expect(listAudit(database, 1)).toEqual([
			expect.objectContaining({
				kind: 'support-code-scam-stop',
				detail: {
					question:
						'Did this code come from your workplace’s IT, or from someone you contacted yourself?',
					address: '192.0.2.40'
				}
			})
		]);
	});
});
