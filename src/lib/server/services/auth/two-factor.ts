import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import {
	RECOVERY_CODE_COUNT,
	SIX_DIGITS,
	twoFactorRequired,
	type TwoFactorKey,
	type TwoFactorStatus
} from '#lib/domain/auth/two-factor.ts';
import { recoveryCodes, totpAuthenticators } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { base32Encode } from '../../crypto/base32.ts';
import { groupCode, normaliseCode, randomCode } from '../../crypto/random-code.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { TOTP_STEP_SECONDS, totpCode } from '../../crypto/totp.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting } from '../settings/settings.ts';
import { providerNamesOf, type UserRow } from '../users/users.ts';
import { verifyPassword } from './passwords.ts';
import { PAUSED, recordSignInFailure, signInPause } from './sign-in-limits.ts';
import { qrPicture } from './two-factor-qr.ts';

/**
 * Two-factor sign-in (SPEC-TWO-FACTOR): an authenticator app's codes (RFC 6238: HMAC-SHA1,
 * 6 digits, 30 s) and single-use recovery codes. The key is sealed with SECRETS_KEY and never
 * shown again once it is on; recovery codes are kept as SHA-256 only (80 random bits each,
 * so a fast hash leaves nothing to guess, section 7).
 */

/** 160 bits, RFC 4226's recommended key length. */
const KEY_BYTES = 20;
/** A pending (not yet confirmed) key is shown again for this long, so a scanned QR keeps working. */
const PENDING_KEY_MS = 60 * 60_000;
/** 16 characters of the 32-letter code alphabet: 80 bits. */
const RECOVERY_CODE_LENGTH = 16;
const ISSUER = 'BMuster';

export type Refused = { kind: 'refused'; status: 400 | 403 | 409 | 429; message: string };

const WRONG_CODE =
	'That code is not right. Check the time on your phone, then try the newest code.';
const WRONG_PASSWORD = 'That password is not right.';

function authenticatorOf(database: Queryable, userId: string) {
	return database
		.select()
		.from(totpAuthenticators)
		.where(eq(totpAuthenticators.userId, userId))
		.get();
}

/** Two-factor is on: an authenticator confirmed with a first code. */
export function isTwoFactorOn(database: Queryable, userId: string): boolean {
	const row = authenticatorOf(database, userId);
	return row !== undefined && row.enabledAt !== null;
}

/** When each person turned two-factor on, for everyone who has it on (the Users page). */
export function twoFactorOnSince(database: Queryable): Map<string, Date> {
	const rows = database
		.select({ userId: totpAuthenticators.userId, enabledAt: totpAuthenticators.enabledAt })
		.from(totpAuthenticators)
		.where(isNotNull(totpAuthenticators.enabledAt))
		.all();
	return new Map(
		rows.flatMap((row) => (row.enabledAt === null ? [] : [[row.userId, row.enabledAt] as const]))
	);
}

/** Whether the server setting makes this person use it. */
export function requiredFor(database: Queryable, user: Pick<UserRow, 'role'>): boolean {
	return twoFactorRequired(getSetting(database, 'twoFactorSignIn'), user.role);
}

function unusedRecoveryCodes(database: Queryable, userId: string): number {
	return (
		database
			.select({ total: count() })
			.from(recoveryCodes)
			.where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
			.get()?.total ?? 0
	);
}

/** The Account page's panel (2.6). */
export function twoFactorStatus(database: Queryable, user: UserRow): TwoFactorStatus {
	if (user.passwordHash === null) {
		return { kind: 'no-password', providerNames: providerNamesOf(database, user.id) };
	}
	const required = requiredFor(database, user);
	const enabledAt = authenticatorOf(database, user.id)?.enabledAt ?? null;
	return enabledAt === null
		? { kind: 'off', required }
		: {
				kind: 'on',
				sinceIso: enabledAt.toISOString(),
				recoveryCodesLeft: unusedRecoveryCodes(database, user.id),
				required
			};
}

function keyFor(email: string, secret: Buffer): TwoFactorKey {
	const encoded = base32Encode(secret);
	const label = encodeURIComponent(`${ISSUER}:${email}`).replace('%3A', ':');
	const otpauthUri = `otpauth://totp/${label}?secret=${encoded}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=${String(TOTP_STEP_SECONDS)}`;
	return {
		otpauthUri,
		keyText: encoded.match(/.{1,4}/g)?.join(' ') ?? encoded,
		qr: qrPicture(otpauthUri)
	};
}

/**
 * Starts set-up (TF2, TF9): a new key, sealed and pending, or the pending one made within the
 * last hour. Refused once two-factor is on (the key is never shown again) and for people with
 * no password (two-factor protects the password).
 */
export function startTotpSetUp(
	database: AppDatabase,
	secretsKey: Buffer,
	user: Pick<UserRow, 'id' | 'email' | 'passwordHash'>,
	now: number
): { kind: 'started'; key: TwoFactorKey } | Refused {
	if (user.passwordHash === null) {
		return {
			kind: 'refused',
			status: 409,
			message: 'You sign in through a sign-in provider, which handles two-step checks.'
		};
	}
	const existing = authenticatorOf(database, user.id);
	if (existing !== undefined && existing.enabledAt !== null) {
		return { kind: 'refused', status: 409, message: 'Two-factor sign-in is already on.' };
	}
	if (existing !== undefined && now - existing.createdAt.getTime() < PENDING_KEY_MS) {
		return {
			kind: 'started',
			key: keyFor(user.email, openSecret(existing.secretSealed, secretsKey))
		};
	}
	const secret = randomBytes(KEY_BYTES);
	const row = {
		userId: user.id,
		secretSealed: sealSecret(secret, secretsKey),
		enabledAt: null,
		lastUsedStep: null,
		createdAt: new Date(now)
	};
	database
		.insert(totpAuthenticators)
		.values(row)
		.onConflictDoUpdate({ target: totpAuthenticators.userId, set: row })
		.run();
	return { kind: 'started', key: keyFor(user.email, secret) };
}

/**
 * The step a typed code belongs to, if it is right: this step or one either side (TF4), and
 * later than the last step used, so no code is accepted twice.
 */
function matchingStep(
	secret: Buffer,
	typed: string,
	lastUsedStep: number | null,
	now: number
): number | undefined {
	if (!SIX_DIGITS.test(typed)) {
		return undefined;
	}
	const current = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
	for (const step of [current - 1, current, current + 1]) {
		if (lastUsedStep !== null && step <= lastUsedStep) {
			continue;
		}
		const expected = totpCode(secret, step * TOTP_STEP_SECONDS);
		if (timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) {
			return step;
		}
	}
	return undefined;
}

/** Checks an authenticator code against the person's key (pending or on) and uses up its step. */
function useAuthenticatorCode(
	database: Queryable,
	secretsKey: Buffer,
	userId: string,
	typed: string,
	now: number
): boolean {
	const row = authenticatorOf(database, userId);
	if (row === undefined) {
		return false;
	}
	const step = matchingStep(
		openSecret(row.secretSealed, secretsKey),
		typed.replace(/\s/g, ''),
		row.lastUsedStep,
		now
	);
	if (step === undefined) {
		return false;
	}
	database
		.update(totpAuthenticators)
		.set({ lastUsedStep: step })
		.where(eq(totpAuthenticators.userId, userId))
		.run();
	return true;
}

function hashRecoveryCode(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Uses up a recovery code; spaces, hyphens and case do not matter. */
function useRecoveryCode(
	database: Queryable,
	userId: string,
	typed: string,
	now: number
): { kind: 'used'; remaining: number } | { kind: 'wrong' } {
	const raw = normaliseCode(typed);
	if (raw.length !== RECOVERY_CODE_LENGTH) {
		return { kind: 'wrong' };
	}
	const row = database
		.select({ id: recoveryCodes.id })
		.from(recoveryCodes)
		.where(
			and(
				eq(recoveryCodes.userId, userId),
				eq(recoveryCodes.codeHash, hashRecoveryCode(raw)),
				isNull(recoveryCodes.usedAt)
			)
		)
		.get();
	if (row === undefined) {
		return { kind: 'wrong' };
	}
	database
		.update(recoveryCodes)
		.set({ usedAt: new Date(now) })
		.where(eq(recoveryCodes.id, row.id))
		.run();
	return { kind: 'used', remaining: unusedRecoveryCodes(database, userId) };
}

export type SecondFactor =
	{ kind: 'code' } | { kind: 'recovery'; remaining: number } | { kind: 'wrong' };

/**
 * Checks what someone typed as their second step, for a person with two-factor on: six digits
 * are an authenticator code, anything else a recovery code (`code-or-recovery` only). A right
 * answer is used up. Callers count a wrong one toward the sign-in pauses.
 */
export function verifySecondFactor(
	database: Queryable,
	secretsKey: Buffer,
	userId: string,
	typed: string,
	accept: 'code-only' | 'code-or-recovery',
	now: number
): SecondFactor {
	if (!isTwoFactorOn(database, userId)) {
		return { kind: 'wrong' };
	}
	const compact = typed.replace(/\s/g, '');
	if (SIX_DIGITS.test(compact)) {
		return useAuthenticatorCode(database, secretsKey, userId, compact, now)
			? { kind: 'code' }
			: { kind: 'wrong' };
	}
	if (accept === 'code-only') {
		return { kind: 'wrong' };
	}
	const used = useRecoveryCode(database, userId, compact, now);
	return used.kind === 'used' ? { kind: 'recovery', remaining: used.remaining } : used;
}

/** A new set of recovery codes, replacing any old ones; returns them as shown (XXXX-XXXX-…). */
function makeRecoveryCodes(database: Queryable, userId: string, now: number): string[] {
	database.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomCode(RECOVERY_CODE_LENGTH));
	database
		.insert(recoveryCodes)
		.values(
			codes.map((raw) => ({
				id: crypto.randomUUID(),
				userId,
				codeHash: hashRecoveryCode(raw),
				createdAt: new Date(now)
			}))
		)
		.run();
	return codes.map((raw) => groupCode(raw, 4));
}

/** Deletes a person's key, pending set-up and recovery codes: turned off or reset. */
export function removeTwoFactor(database: Queryable, userId: string): void {
	database.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
	database.delete(totpAuthenticators).where(eq(totpAuthenticators.userId, userId)).run();
}

/**
 * Refuses a paused email or address before anything is checked (SPEC-SIGN-IN S4), and audits
 * the refusal like the sign-in page does.
 */
export function pausedRefusal(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'email'>,
	ip: string,
	method: string,
	now: number
): Refused | undefined {
	const pause = signInPause(database, { email: user.email, address: ip }, now);
	if (pause.kind === 'none') {
		return undefined;
	}
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'sign-in-failed',
			target: user.email,
			machineId: null,
			detail: { method, reason: `paused-${pause.by}`, ip }
		},
		now
	);
	return { kind: 'refused', status: 429, message: PAUSED };
}

/** A wrong code or password counts toward the pauses (TF6) and goes to Activity. */
export function recordWrongAnswer(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'email'>,
	ip: string,
	detail: { method: string; reason: 'wrong-code' | 'wrong-password' },
	now: number
): void {
	recordSignInFailure(database, { email: user.email, address: ip }, now);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'sign-in-failed',
			target: user.email,
			machineId: null,
			detail: { ...detail, ip }
		},
		now
	);
}

/**
 * Turns two-factor on with the first code from the app (TF3), and the password on the Account
 * page (at sign-in it was just typed). Returns the recovery codes, shown once.
 */
export async function confirmTotpSetUp(
	database: AppDatabase,
	secretsKey: Buffer,
	user: Pick<UserRow, 'id' | 'email' | 'passwordHash'>,
	input: {
		code: string;
		password: { kind: 'just-typed' } | { kind: 'given'; password: string };
	},
	context: { ip: string; where: 'account' | 'sign-in' },
	now: number
): Promise<{ kind: 'on'; recoveryCodes: string[] } | Refused> {
	const pending = authenticatorOf(database, user.id);
	if (pending?.enabledAt !== null) {
		return {
			kind: 'refused',
			status: 409,
			message: 'Start set-up again: this key is no longer waiting for a code.'
		};
	}
	const paused = pausedRefusal(database, user, context.ip, 'two-factor set-up', now);
	if (paused !== undefined) {
		return paused;
	}
	if (input.password.kind === 'given') {
		const right =
			user.passwordHash !== null &&
			(await verifyPassword(user.passwordHash, input.password.password));
		if (!right) {
			recordWrongAnswer(
				database,
				user,
				context.ip,
				{ method: 'two-factor set-up', reason: 'wrong-password' },
				now
			);
			return { kind: 'refused', status: 403, message: WRONG_PASSWORD };
		}
	}
	return database.transaction((transaction) => {
		if (!useAuthenticatorCode(transaction, secretsKey, user.id, input.code, now)) {
			recordWrongAnswer(
				transaction,
				user,
				context.ip,
				{ method: 'two-factor set-up', reason: 'wrong-code' },
				now
			);
			return { kind: 'refused', status: 403, message: WRONG_CODE };
		}
		transaction
			.update(totpAuthenticators)
			.set({ enabledAt: new Date(now) })
			.where(eq(totpAuthenticators.userId, user.id))
			.run();
		const codes = makeRecoveryCodes(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'two-factor-turned-on',
				target: user.email,
				machineId: null,
				detail: {
					where: context.where === 'account' ? 'Account page' : 'at sign-in',
					ip: context.ip
				}
			},
			now
		);
		return { kind: 'on', recoveryCodes: codes };
	});
}

/** Turns it off (TF11): the password and a current code or a recovery code; not while required. */
export async function turnOffTwoFactor(
	database: AppDatabase,
	secretsKey: Buffer,
	user: UserRow,
	input: { password: string; code: string },
	ip: string,
	now: number
): Promise<{ kind: 'off' } | Refused> {
	if (!isTwoFactorOn(database, user.id)) {
		return { kind: 'refused', status: 409, message: 'Two-factor sign-in is already off.' };
	}
	if (requiredFor(database, user)) {
		return {
			kind: 'refused',
			status: 409,
			message:
				'This server requires two-factor sign-in for you, so it cannot be turned off. An admin can change that in Settings.'
		};
	}
	const paused = pausedRefusal(database, user, ip, 'turning two-factor off', now);
	if (paused !== undefined) {
		return paused;
	}
	if (user.passwordHash === null || !(await verifyPassword(user.passwordHash, input.password))) {
		recordWrongAnswer(
			database,
			user,
			ip,
			{ method: 'turning two-factor off', reason: 'wrong-password' },
			now
		);
		return { kind: 'refused', status: 403, message: WRONG_PASSWORD };
	}
	return database.transaction((transaction) => {
		const answer = verifySecondFactor(
			transaction,
			secretsKey,
			user.id,
			input.code,
			'code-or-recovery',
			now
		);
		if (answer.kind === 'wrong') {
			recordWrongAnswer(
				transaction,
				user,
				ip,
				{ method: 'turning two-factor off', reason: 'wrong-code' },
				now
			);
			return { kind: 'refused', status: 403, message: WRONG_CODE };
		}
		if (answer.kind === 'recovery') {
			recordRecoveryCodeUse(transaction, user, 'turning two-factor off', answer.remaining, now);
		}
		removeTwoFactor(transaction, user.id);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'two-factor-turned-off',
				target: user.email,
				machineId: null,
				detail: { with: answer.kind === 'code' ? 'authenticator code' : 'recovery code' }
			},
			now
		);
		return { kind: 'off' };
	});
}

/** New recovery codes (TF12) for a current authenticator code; the old set stops working. */
export function replaceRecoveryCodes(
	database: AppDatabase,
	secretsKey: Buffer,
	user: Pick<UserRow, 'id' | 'email'>,
	input: { code: string },
	ip: string,
	now: number
): { kind: 'replaced'; recoveryCodes: string[] } | Refused {
	if (!isTwoFactorOn(database, user.id)) {
		return { kind: 'refused', status: 409, message: 'Two-factor sign-in is off.' };
	}
	const paused = pausedRefusal(database, user, ip, 'new recovery codes', now);
	if (paused !== undefined) {
		return paused;
	}
	return database.transaction((transaction) => {
		const answer = verifySecondFactor(
			transaction,
			secretsKey,
			user.id,
			input.code,
			'code-only',
			now
		);
		if (answer.kind !== 'code') {
			recordWrongAnswer(
				transaction,
				user,
				ip,
				{ method: 'new recovery codes', reason: 'wrong-code' },
				now
			);
			return {
				kind: 'refused',
				status: 403,
				message: 'Type the 6-digit code your authenticator app shows now.'
			};
		}
		const codes = makeRecoveryCodes(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'recovery-codes-replaced',
				target: user.email,
				machineId: null,
				detail: { ip }
			},
			now
		);
		return { kind: 'replaced', recoveryCodes: codes };
	});
}

/** A recovery code was used (TF10): what for, and how many are left. */
export function recordRecoveryCodeUse(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'email'>,
	usedFor: string,
	remaining: number,
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'recovery-code-used',
			target: user.email,
			machineId: null,
			detail: { for: usedFor, remaining: String(remaining) }
		},
		now
	);
}
