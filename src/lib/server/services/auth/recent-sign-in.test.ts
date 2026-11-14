import { describe, expect, it } from 'vitest';
import { SECRETS_KEY } from '#tests/helpers/email.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { codeFor, turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import { listAudit } from '../audit/audit.ts';
import { reconfirmSignIn, signInCheck } from './recent-sign-in.ts';
import { startSession } from './sessions.ts';
import { EMAIL_LIMIT } from './sign-in-limits.ts';

const TEN_MINUTES = 10 * 60_000;
const LATER = NOW + 20 * 60_000;

async function signedInWithTwoFactor() {
	const database = testDatabase();
	const user = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: PASSWORD
	});
	const codes = await turnOnTwoFactor(database, user, NOW);
	const { token } = startSession(database, user.id, CLIENT, NOW);
	return { database, user, codes, token };
}

describe('the recent sign-in check with two-factor on (SPEC-TWO-FACTOR TF13)', () => {
	it('asks for an authenticator code instead of the password', async () => {
		const { database, user, token } = await signedInWithTwoFactor();
		expect(signInCheck(database, token, user.id, TEN_MINUTES, NOW + 60_000)).toEqual({
			kind: 'recent'
		});
		expect(signInCheck(database, token, user.id, TEN_MINUTES, LATER)).toEqual({ kind: 'code' });
	});

	it('accepts a right code, which makes the session recent again', async () => {
		const { database, user, token } = await signedInWithTwoFactor();
		const result = await reconfirmSignIn(
			database,
			SECRETS_KEY,
			{
				token,
				userId: user.id,
				recheck: { kind: 'code', code: codeFor(database, user.id, LATER) },
				ip: CLIENT.ip
			},
			LATER
		);
		expect(result).toEqual({ kind: 'confirmed' });
		expect(signInCheck(database, token, user.id, TEN_MINUTES, LATER + 1000)).toEqual({
			kind: 'recent'
		});
		expect(listAudit(database, 1)[0]).toMatchObject({ kind: 'code-confirmed' });
	});

	it('refuses the password, and a recovery code, when two-factor is on', async () => {
		const { database, user, token, codes } = await signedInWithTwoFactor();
		const password = await reconfirmSignIn(
			database,
			SECRETS_KEY,
			{ token, userId: user.id, recheck: { kind: 'password', password: PASSWORD }, ip: CLIENT.ip },
			LATER
		);
		expect(password).toMatchObject({ kind: 'refused', status: 403 });
		const recovery = await reconfirmSignIn(
			database,
			SECRETS_KEY,
			{ token, userId: user.id, recheck: { kind: 'code', code: codes[0] ?? '' }, ip: CLIENT.ip },
			LATER
		);
		expect(recovery).toMatchObject({ kind: 'refused', status: 403 });
		expect(signInCheck(database, token, user.id, TEN_MINUTES, LATER)).toEqual({ kind: 'code' });
	});

	it('counts wrong codes toward the sign-in pauses', async () => {
		const { database, user, token } = await signedInWithTwoFactor();
		const wrong = codeFor(database, user.id, LATER) === '000000' ? '111111' : '000000';
		for (let attempt = 0; attempt < EMAIL_LIMIT.failures; attempt += 1) {
			await reconfirmSignIn(
				database,
				SECRETS_KEY,
				{ token, userId: user.id, recheck: { kind: 'code', code: wrong }, ip: CLIENT.ip },
				LATER
			);
		}
		const paused = await reconfirmSignIn(
			database,
			SECRETS_KEY,
			{
				token,
				userId: user.id,
				recheck: { kind: 'code', code: codeFor(database, user.id, LATER) },
				ip: CLIENT.ip
			},
			LATER
		);
		expect(paused).toMatchObject({ kind: 'refused', status: 429 });
	});

	it('still asks for the password without two-factor', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'pat@example.com',
			role: 'member',
			password: PASSWORD
		});
		const { token } = startSession(database, user.id, CLIENT, NOW);
		expect(signInCheck(database, token, user.id, TEN_MINUTES, LATER)).toEqual({ kind: 'password' });
		const result = await reconfirmSignIn(
			database,
			SECRETS_KEY,
			{ token, userId: user.id, recheck: { kind: 'password', password: PASSWORD }, ip: CLIENT.ip },
			LATER
		);
		expect(result).toEqual({ kind: 'confirmed' });
	});
});
