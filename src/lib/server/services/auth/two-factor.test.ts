import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SECRETS_KEY } from '#tests/helpers/email.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { codeFor, turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import { recoveryCodes, totpAuthenticators } from '../../database/schema.ts';
import { openSecret } from '../../crypto/secret-box.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSettingAsSystem } from '../settings/settings.ts';
import {
	confirmTotpSetUp,
	isTwoFactorOn,
	replaceRecoveryCodes,
	startTotpSetUp,
	turnOffTwoFactor,
	twoFactorStatus,
	verifySecondFactor
} from './two-factor.ts';

const STEP = 30_000;

async function person(role: 'admin' | 'member' = 'admin') {
	const database = testDatabase();
	const user = await addTestUser(database, { email: 'ada@example.com', role, password: PASSWORD });
	return { database, user };
}

describe('setting up two-factor (SPEC-TWO-FACTOR TF2, TF3, TF9)', () => {
	it('gives an otpauth URI for BMuster and the email, the key in groups, and a QR picture', async () => {
		const { database, user } = await person();
		const started = startTotpSetUp(database, SECRETS_KEY, user, NOW);
		if (started.kind !== 'started') throw new Error(started.message);
		const uri = new URL(started.key.otpauthUri);
		expect(uri.protocol).toBe('otpauth:');
		expect(uri.host).toBe('totp');
		expect(decodeURIComponent(uri.pathname)).toBe('/BMuster:ada@example.com');
		const secret = uri.searchParams.get('secret') ?? '';
		expect(secret).toMatch(/^[A-Z2-7]{32}$/);
		expect(uri.searchParams.get('issuer')).toBe('BMuster');
		expect(uri.searchParams.get('digits')).toBe('6');
		expect(uri.searchParams.get('period')).toBe('30');
		expect(started.key.keyText.replaceAll(' ', '')).toBe(secret);
		expect(started.key.keyText).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
		expect(started.key.qr.path.length).toBeGreaterThan(0);
	});

	it('keeps the key only sealed with SECRETS_KEY, and not on until a first code', async () => {
		const { database, user } = await person();
		const started = startTotpSetUp(database, SECRETS_KEY, user, NOW);
		if (started.kind !== 'started') throw new Error(started.message);
		const [row] = database.select().from(totpAuthenticators).all();
		const secret = new URL(started.key.otpauthUri).searchParams.get('secret') ?? '';
		expect(row?.secretSealed).not.toContain(secret);
		expect(row?.secretSealed.startsWith('v1.')).toBe(true);
		expect(openSecret(row?.secretSealed ?? '', SECRETS_KEY)).toHaveLength(20);
		expect(row?.enabledAt).toBeNull();
		expect(isTwoFactorOn(database, user.id)).toBe(false);
	});

	it('turns on with a right code and the password, giving 10 recovery codes kept only as SHA-256', async () => {
		const { database, user } = await person();
		const codes = await turnOnTwoFactor(database, user, NOW);
		expect(codes).toHaveLength(10);
		for (const code of codes) {
			expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
		}
		expect(new Set(codes).size).toBe(10);
		const stored = database.select().from(recoveryCodes).all();
		expect(stored.map((row) => row.codeHash).sort()).toEqual(
			codes
				.map((code) => createHash('sha256').update(code.replaceAll('-', '')).digest('hex'))
				.sort()
		);
		expect(isTwoFactorOn(database, user.id)).toBe(true);
		expect(listAudit(database, 10).map((entry) => entry.kind)).toContain('two-factor-turned-on');
	});

	it('refuses a wrong first code or a wrong password, and stays off', async () => {
		const { database, user } = await person();
		startTotpSetUp(database, SECRETS_KEY, user, NOW);
		const right = codeFor(database, user.id, NOW);
		const wrongCode = await confirmTotpSetUp(
			database,
			SECRETS_KEY,
			user,
			{
				code: right === '000000' ? '111111' : '000000',
				password: { kind: 'given', password: PASSWORD }
			},
			{ ip: CLIENT.ip, where: 'account' },
			NOW
		);
		expect(wrongCode.kind).toBe('refused');
		const wrongPassword = await confirmTotpSetUp(
			database,
			SECRETS_KEY,
			user,
			{ code: right, password: { kind: 'given', password: 'not the password' } },
			{ ip: CLIENT.ip, where: 'account' },
			NOW
		);
		expect(wrongPassword.kind).toBe('refused');
		expect(isTwoFactorOn(database, user.id)).toBe(false);
	});

	it('shows the same pending key for an hour, then a new one', async () => {
		const { database, user } = await person();
		const first = startTotpSetUp(database, SECRETS_KEY, user, NOW);
		const again = startTotpSetUp(database, SECRETS_KEY, user, NOW + 59 * 60_000);
		const later = startTotpSetUp(database, SECRETS_KEY, user, NOW + 61 * 60_000);
		if (first.kind !== 'started' || again.kind !== 'started' || later.kind !== 'started') {
			throw new Error('set-up refused');
		}
		expect(again.key.otpauthUri).toBe(first.key.otpauthUri);
		expect(later.key.otpauthUri).not.toBe(first.key.otpauthUri);
	});

	it('refuses to start again while it is on, so the key is never shown after set-up', async () => {
		const { database, user } = await person();
		await turnOnTwoFactor(database, user, NOW);
		expect(startTotpSetUp(database, SECRETS_KEY, user, NOW + STEP).kind).toBe('refused');
	});

	it('is only for people with a password', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'sso@example.com',
			role: 'member',
			password: null
		});
		expect(startTotpSetUp(database, SECRETS_KEY, user, NOW).kind).toBe('refused');
	});
});

describe('checking codes (TF4)', () => {
	it('accepts one step of drift either way, not two', async () => {
		for (const [offset, expected] of [
			[-2, 'wrong'],
			[-1, 'code'],
			[0, 'code'],
			[1, 'code'],
			[2, 'wrong']
		] as const) {
			const { database, user } = await person();
			await turnOnTwoFactor(database, user, NOW);
			const at = NOW + 10 * STEP;
			const shown = codeFor(database, user.id, at + offset * STEP);
			// Two steps' codes can match by chance (one in a million); then the check proves nothing.
			if (offset === 2 || offset === -2) {
				const near = [-1, 0, 1].map((near) => codeFor(database, user.id, at + near * STEP));
				if (near.includes(shown)) continue;
			}
			const result = verifySecondFactor(database, SECRETS_KEY, user.id, shown, 'code-only', at);
			expect(result.kind, `offset ${offset}`).toBe(expected);
		}
	});

	it('accepts each step once per person', async () => {
		const { database, user } = await person();
		await turnOnTwoFactor(database, user, NOW);
		const at = NOW + 5 * STEP;
		const code = codeFor(database, user.id, at);
		expect(verifySecondFactor(database, SECRETS_KEY, user.id, code, 'code-only', at).kind).toBe(
			'code'
		);
		expect(verifySecondFactor(database, SECRETS_KEY, user.id, code, 'code-only', at).kind).toBe(
			'wrong'
		);
		// An earlier step than the last used one is refused too.
		const earlier = codeFor(database, user.id, at - STEP);
		expect(verifySecondFactor(database, SECRETS_KEY, user.id, earlier, 'code-only', at).kind).toBe(
			'wrong'
		);
	});
});

describe('turning off and new recovery codes (TF11, TF12)', () => {
	it('turns off with the password and a current code, removing the key and codes', async () => {
		const { database, user } = await person('member');
		await turnOnTwoFactor(database, user, NOW);
		const at = NOW + 3 * STEP;
		const result = await turnOffTwoFactor(
			database,
			SECRETS_KEY,
			user,
			{ password: PASSWORD, code: codeFor(database, user.id, at) },
			CLIENT.ip,
			at
		);
		expect(result.kind).toBe('off');
		expect(isTwoFactorOn(database, user.id)).toBe(false);
		expect(database.select().from(totpAuthenticators).all()).toHaveLength(0);
		expect(database.select().from(recoveryCodes).all()).toHaveLength(0);
		expect(listAudit(database, 10)[0]).toEqual(
			expect.objectContaining({
				kind: 'two-factor-turned-off',
				detail: { with: 'authenticator code' }
			})
		);
	});

	it('turns off with a recovery code, but not without the password', async () => {
		const { database, user } = await person('member');
		const [first, second] = await turnOnTwoFactor(database, user, NOW);
		const noPassword = await turnOffTwoFactor(
			database,
			SECRETS_KEY,
			user,
			{ password: 'not the password', code: first ?? '' },
			CLIENT.ip,
			NOW + STEP
		);
		expect(noPassword.kind).toBe('refused');
		expect(isTwoFactorOn(database, user.id)).toBe(true);
		const result = await turnOffTwoFactor(
			database,
			SECRETS_KEY,
			user,
			{ password: PASSWORD, code: (second ?? '').toLowerCase() },
			CLIENT.ip,
			NOW + STEP
		);
		expect(result.kind).toBe('off');
	});

	it('cannot be turned off while the setting requires it for the person', async () => {
		const { database, user } = await person('admin');
		await turnOnTwoFactor(database, user, NOW);
		updateSettingAsSystem(database, 'twoFactorSignIn', 'admins', 'test', NOW);
		const at = NOW + 3 * STEP;
		const result = await turnOffTwoFactor(
			database,
			SECRETS_KEY,
			user,
			{ password: PASSWORD, code: codeFor(database, user.id, at) },
			CLIENT.ip,
			at
		);
		expect(result).toEqual(expect.objectContaining({ kind: 'refused', status: 409 }));
		expect(isTwoFactorOn(database, user.id)).toBe(true);
	});

	it('replaces the whole set of recovery codes for a current authenticator code', async () => {
		const { database, user } = await person();
		const old = await turnOnTwoFactor(database, user, NOW);
		const at = NOW + 3 * STEP;
		const refused = replaceRecoveryCodes(
			database,
			SECRETS_KEY,
			user,
			{ code: old[0] ?? '' },
			CLIENT.ip,
			at
		);
		expect(refused.kind).toBe('refused');
		const result = replaceRecoveryCodes(
			database,
			SECRETS_KEY,
			user,
			{ code: codeFor(database, user.id, at) },
			CLIENT.ip,
			at
		);
		if (result.kind !== 'replaced') throw new Error(result.message);
		expect(result.recoveryCodes).toHaveLength(10);
		expect(result.recoveryCodes).not.toContain(old[1]);
		expect(
			verifySecondFactor(database, SECRETS_KEY, user.id, old[1] ?? '', 'code-or-recovery', at).kind
		).toBe('wrong');
		expect(
			verifySecondFactor(
				database,
				SECRETS_KEY,
				user.id,
				result.recoveryCodes[0] ?? '',
				'code-or-recovery',
				at
			)
		).toEqual({ kind: 'recovery', remaining: 9 });
		expect(listAudit(database, 10).map((entry) => entry.kind)).toContain('recovery-codes-replaced');
	});

	it('reports on or off, when, and how many recovery codes are left', async () => {
		const { database, user } = await person('admin');
		expect(twoFactorStatus(database, user)).toEqual({ kind: 'off', required: false });
		const codes = await turnOnTwoFactor(database, user, NOW);
		verifySecondFactor(database, SECRETS_KEY, user.id, codes[0] ?? '', 'code-or-recovery', NOW);
		updateSettingAsSystem(database, 'twoFactorSignIn', 'everyone', 'test', NOW);
		expect(twoFactorStatus(database, user)).toEqual({
			kind: 'on',
			sinceIso: new Date(NOW).toISOString(),
			recoveryCodesLeft: 9,
			required: true
		});
	});
});
