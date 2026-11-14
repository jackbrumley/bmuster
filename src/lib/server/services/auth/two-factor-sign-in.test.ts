import { describe, expect, it } from 'vitest';
import { SECRETS_KEY } from '#tests/helpers/email.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { codeFor, turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { consoleSessions } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSettingAsSystem } from '../settings/settings.ts';
import type { UserRow } from '../users/users.ts';
import { authenticateSession } from './current-user.ts';
import { signInWithPassword } from './password-sign-in.ts';
import { findSession } from './sessions.ts';
import { CHALLENGE_MS, type StartedChallenge } from './sign-in-challenges.ts';
import { PAUSED } from './sign-in-limits.ts';
import { isTwoFactorOn } from './two-factor.ts';
import { answerCodeStep, answerSetUpStep, setUpStepKey } from './two-factor-sign-in.ts';

const STEP = 30_000;

async function passwordStep(
	database: AppDatabase,
	email: string,
	at: number
): Promise<StartedChallenge> {
	const result = await signInWithPassword(database, { email, password: PASSWORD }, CLIENT, at);
	if (result.kind !== 'second-step') throw new Error(`expected a second step, got ${result.kind}`);
	return result.challenge;
}

async function withTwoFactor(): Promise<{ database: AppDatabase; user: UserRow; codes: string[] }> {
	const database = testDatabase();
	const user = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: PASSWORD
	});
	const codes = await turnOnTwoFactor(database, user, NOW);
	return { database, user, codes };
}

describe('the code step (SPEC-TWO-FACTOR TF5, TF7)', () => {
	it('starts a 5-minute challenge, not a session, then a session for the right code', async () => {
		const { database, user } = await withTwoFactor();
		const at = NOW + 4 * STEP;
		const challenge = await passwordStep(database, 'ada@example.com', at);
		expect(challenge.step).toBe('code');
		expect(challenge.expiresAt.getTime()).toBe(at + CHALLENGE_MS);
		expect(CHALLENGE_MS).toBe(5 * 60_000);
		expect(database.select().from(consoleSessions).all()).toHaveLength(0);

		const result = answerCodeStep(
			database,
			SECRETS_KEY,
			challenge.token,
			codeFor(database, user.id, at),
			CLIENT,
			at
		);
		if (result.kind !== 'signed-in') throw new Error(result.kind);
		expect(findSession(database, result.session.token, at)).toEqual({
			kind: 'active',
			userId: user.id
		});
		expect(listAudit(database, 1)[0]).toEqual(
			expect.objectContaining({
				kind: 'sign-in',
				detail: { method: 'password and authenticator code', ip: CLIENT.ip }
			})
		);
		// Used once.
		expect(
			answerCodeStep(
				database,
				SECRETS_KEY,
				challenge.token,
				codeFor(database, user.id, at + STEP),
				CLIENT,
				at + STEP
			).kind
		).toBe('timed-out');
	});

	it('refuses an expired or unknown challenge', async () => {
		const { database, user } = await withTwoFactor();
		const challenge = await passwordStep(database, 'ada@example.com', NOW + STEP);
		const late = NOW + STEP + CHALLENGE_MS + 1;
		expect(
			answerCodeStep(
				database,
				SECRETS_KEY,
				challenge.token,
				codeFor(database, user.id, late),
				CLIENT,
				late
			).kind
		).toBe('timed-out');
		expect(answerCodeStep(database, SECRETS_KEY, 'nonsense', '123456', CLIENT, NOW).kind).toBe(
			'timed-out'
		);
	});

	it('grants nothing: the challenge token is not a session', async () => {
		const { database } = await withTwoFactor();
		const challenge = await passwordStep(database, 'ada@example.com', NOW + STEP);
		expect(findSession(database, challenge.token, NOW + STEP)).toEqual({ kind: 'none' });
		expect(authenticateSession(database, challenge.token, NOW + STEP)).toBeUndefined();
	});

	it('ends older challenges when a new one starts', async () => {
		const { database, user } = await withTwoFactor();
		const first = await passwordStep(database, 'ada@example.com', NOW + STEP);
		await passwordStep(database, 'ada@example.com', NOW + STEP);
		const at = NOW + 2 * STEP;
		expect(
			answerCodeStep(database, SECRETS_KEY, first.token, codeFor(database, user.id, at), CLIENT, at)
				.kind
		).toBe('timed-out');
	});
});

describe('wrong codes and the pauses (TF6)', () => {
	it('counts wrong codes toward the email pause and refuses a right code while paused', async () => {
		const { database, user } = await withTwoFactor();
		const at = NOW + 10 * STEP;
		const challenge = await passwordStep(database, 'ada@example.com', at);
		const right = codeFor(database, user.id, at);
		const wrong = right === '000000' ? '111111' : '000000';
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(answerCodeStep(database, SECRETS_KEY, challenge.token, wrong, CLIENT, at)).toEqual(
				expect.objectContaining({ kind: 'refused' })
			);
		}
		expect(answerCodeStep(database, SECRETS_KEY, challenge.token, right, CLIENT, at)).toEqual({
			kind: 'refused',
			message: PAUSED
		});
		expect(listAudit(database, 10)).toContainEqual(
			expect.objectContaining({
				kind: 'sign-in-failed',
				detail: { method: 'authenticator code', reason: 'wrong-code', ip: CLIENT.ip }
			})
		);
	});

	it('does not clear the failures when only the password was right', async () => {
		const { database, user } = await withTwoFactor();
		const at = NOW + 10 * STEP;
		const wrong = codeFor(database, user.id, at) === '000000' ? '111111' : '000000';
		const first = await passwordStep(database, 'ada@example.com', at);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			answerCodeStep(database, SECRETS_KEY, first.token, wrong, CLIENT, at);
		}
		const second = await passwordStep(database, 'ada@example.com', at);
		answerCodeStep(database, SECRETS_KEY, second.token, wrong, CLIENT, at);
		const result = await signInWithPassword(
			database,
			{ email: 'ada@example.com', password: PASSWORD },
			CLIENT,
			at
		);
		expect(result).toEqual({ kind: 'refused', message: PAUSED });
	});
});

describe('recovery codes at sign-in (TF10)', () => {
	it('signs in once with a recovery code and audits how many remain', async () => {
		const { database, codes } = await withTwoFactor();
		const code = codes[3] ?? '';
		const challenge = await passwordStep(database, 'ada@example.com', NOW + STEP);
		const result = answerCodeStep(
			database,
			SECRETS_KEY,
			challenge.token,
			` ${code.toLowerCase()} `,
			CLIENT,
			NOW + STEP
		);
		expect(result.kind).toBe('signed-in');
		const audit = listAudit(database, 5);
		expect(audit).toContainEqual(
			expect.objectContaining({
				kind: 'recovery-code-used',
				detail: { for: 'signing in', remaining: '9' }
			})
		);
		expect(audit).toContainEqual(
			expect.objectContaining({
				kind: 'sign-in',
				detail: { method: 'password and recovery code', ip: CLIENT.ip }
			})
		);
		const again = await passwordStep(database, 'ada@example.com', NOW + 2 * STEP);
		expect(
			answerCodeStep(database, SECRETS_KEY, again.token, code, CLIENT, NOW + 2 * STEP)
		).toEqual(expect.objectContaining({ kind: 'refused' }));
	});
});

describe('required but not set up (TF8)', () => {
	it('takes a required admin to set-up, and starts the session only after a first code', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: PASSWORD
		});
		updateSettingAsSystem(database, 'twoFactorSignIn', 'admins', 'test', NOW);
		const challenge = await passwordStep(database, 'ada@example.com', NOW);
		expect(challenge.step).toBe('set-up');
		expect(database.select().from(consoleSessions).all()).toHaveLength(0);
		// A set-up challenge does not answer the code step.
		expect(answerCodeStep(database, SECRETS_KEY, challenge.token, '123456', CLIENT, NOW).kind).toBe(
			'timed-out'
		);

		const shown = setUpStepKey(database, SECRETS_KEY, challenge.token, NOW);
		if (shown.kind !== 'key') throw new Error(shown.kind);
		expect(shown.key.otpauthUri).toContain('BMuster:ada%40example.com');
		const again = setUpStepKey(database, SECRETS_KEY, challenge.token, NOW + 1000);
		expect(again).toEqual(shown);

		const result = await answerSetUpStep(
			database,
			SECRETS_KEY,
			challenge.token,
			codeFor(database, admin.id, NOW + STEP),
			CLIENT,
			NOW + STEP
		);
		if (result.kind !== 'signed-in') throw new Error(result.kind);
		expect(result.recoveryCodes).toHaveLength(10);
		expect(isTwoFactorOn(database, admin.id)).toBe(true);
		expect(findSession(database, result.session.token, NOW + STEP).kind).toBe('active');
		expect(listAudit(database, 5)).toContainEqual(
			expect.objectContaining({
				kind: 'two-factor-turned-on',
				detail: { where: 'at sign-in', ip: CLIENT.ip }
			})
		);
	});

	it('signs in someone it does not require, as before', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: PASSWORD });
		updateSettingAsSystem(database, 'twoFactorSignIn', 'admins', 'test', NOW);
		const result = await signInWithPassword(
			database,
			{ email: 'pat@example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		expect(result.kind).toBe('signed-in');
	});

	it('requires everyone with a password when set to everyone', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: PASSWORD });
		updateSettingAsSystem(database, 'twoFactorSignIn', 'everyone', 'test', NOW);
		expect((await passwordStep(database, 'pat@example.com', NOW)).step).toBe('set-up');
	});
});
