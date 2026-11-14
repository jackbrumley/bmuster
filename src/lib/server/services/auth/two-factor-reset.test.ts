import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import { recoveryCodes, totpAuthenticators } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSettingAsSystem } from '../settings/settings.ts';
import { toConsoleUser } from '../users/users.ts';
import { signInWithPassword } from './password-sign-in.ts';
import { findSession, startSession } from './sessions.ts';
import { EMAIL_LIMIT, recordSignInFailure, signInPause } from './sign-in-limits.ts';
import { isTwoFactorOn, twoFactorOnSince } from './two-factor.ts';
import { resetTwoFactorByAdmin, resetTwoFactorFromHost } from './two-factor-reset.ts';

async function office() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: PASSWORD
	});
	const other = await addTestUser(database, {
		email: 'bea@example.com',
		role: 'admin',
		password: PASSWORD
	});
	await turnOnTwoFactor(database, admin, NOW);
	await turnOnTwoFactor(database, other, NOW);
	return { database, admin, other };
}

describe('an admin resets someone’s two-factor (SPEC-TWO-FACTOR TF14)', () => {
	it('lists who has it on, for the Users page', async () => {
		const { database, admin, other } = await office();
		expect([...twoFactorOnSince(database).keys()].sort()).toEqual([admin.id, other.id].sort());
	});

	it('removes another person’s key and codes, audited, and leaves their sessions', async () => {
		const { database, admin, other } = await office();
		const session = startSession(database, other.id, CLIENT, NOW);
		const result = resetTwoFactorByAdmin(database, toConsoleUser(admin), other.id, NOW);
		expect(result).toEqual({ kind: 'reset' });
		expect(isTwoFactorOn(database, other.id)).toBe(false);
		expect(
			database
				.select()
				.from(recoveryCodes)
				.all()
				.every((row) => row.userId !== other.id)
		).toBe(true);
		expect(findSession(database, session.token, NOW).kind).toBe('active');
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'two-factor-reset',
			actorUserId: admin.id,
			target: 'bea@example.com',
			detail: { how: 'by an admin' }
		});
	});

	it('makes them set it up again at their next sign-in when it is required', async () => {
		const { database, admin, other } = await office();
		updateSettingAsSystem(database, 'twoFactorSignIn', 'admins', 'test', NOW);
		resetTwoFactorByAdmin(database, toConsoleUser(admin), other.id, NOW);
		expect(
			await signInWithPassword(
				database,
				{ email: 'bea@example.com', password: PASSWORD },
				CLIENT,
				NOW
			)
		).toMatchObject({ kind: 'second-step', challenge: { step: 'set-up' } });
	});

	it('refuses an admin’s own, someone without it on, and an unknown id', async () => {
		const { database, admin } = await office();
		const pat = await addTestUser(database, {
			email: 'pat@example.com',
			role: 'member',
			password: PASSWORD
		});
		const actor = toConsoleUser(admin);
		expect(resetTwoFactorByAdmin(database, actor, admin.id, NOW)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(resetTwoFactorByAdmin(database, actor, pat.id, NOW)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(resetTwoFactorByAdmin(database, actor, crypto.randomUUID(), NOW)).toMatchObject({
			kind: 'refused',
			status: 404
		});
		expect(isTwoFactorOn(database, admin.id)).toBe(true);
	});
});

describe('the host command (TF15)', () => {
	it('resets any account’s two-factor, clears its pause, and is audited as the system', async () => {
		const { database, admin } = await office();
		for (let attempt = 0; attempt < EMAIL_LIMIT.failures; attempt += 1) {
			recordSignInFailure(database, { email: admin.email, address: CLIENT.ip }, NOW);
		}
		expect(signInPause(database, { email: admin.email, address: '198.51.100.1' }, NOW).kind).toBe(
			'paused'
		);
		const result = resetTwoFactorFromHost(database, ' ADA@example.com ', NOW);
		expect(result).toEqual({ kind: 'reset', email: 'ada@example.com', wasOn: true });
		expect(isTwoFactorOn(database, admin.id)).toBe(false);
		expect(signInPause(database, { email: admin.email, address: '198.51.100.1' }, NOW).kind).toBe(
			'none'
		);
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'two-factor-reset',
			actorUserId: null,
			target: 'ada@example.com',
			detail: { how: 'from the server command line' }
		});
	});

	it('refuses an unknown email and changes nothing', async () => {
		const { database } = await office();
		const before = database.select().from(totpAuthenticators).all();
		expect(resetTwoFactorFromHost(database, 'nobody@example.com', NOW)).toMatchObject({
			kind: 'refused'
		});
		expect(database.select().from(totpAuthenticators).all()).toEqual(before);
	});
});
