import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserByEmail, findUserById } from '../users/users.ts';
import { endChallenges } from './sign-in-challenges.ts';
import { clearSignInFailures } from './sign-in-limits.ts';
import { isTwoFactorOn, removeTwoFactor } from './two-factor.ts';

/**
 * Resetting someone's two-factor sign-in (SPEC-TWO-FACTOR 2.8, 2.9): their key, pending set-up
 * and recovery codes go, and any half-finished sign-in ends. Their sessions are left alone. If
 * the server requires two-factor for them, they set it up again at their next sign-in.
 */

export type AdminReset =
	{ kind: 'reset' } | { kind: 'refused'; status: 404 | 409; message: string };

/** An admin resets another person's two-factor, from the Users page (TF14). */
export function resetTwoFactorByAdmin(
	database: AppDatabase,
	actor: ConsoleUser,
	userId: string,
	now: number
): AdminReset {
	if (userId === actor.id) {
		return {
			kind: 'refused',
			status: 409,
			message: 'Turn off your own two-factor sign-in on your Account page.'
		};
	}
	return database.transaction((transaction): AdminReset => {
		const user = findUserById(transaction, userId);
		if (user === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		if (!isTwoFactorOn(transaction, user.id)) {
			return {
				kind: 'refused',
				status: 409,
				message: `Two-factor sign-in is not on for ${user.name}.`
			};
		}
		removeTwoFactor(transaction, user.id);
		endChallenges(transaction, user.id);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actor.id },
				kind: 'two-factor-reset',
				target: user.email,
				machineId: null,
				detail: { how: 'by an admin' }
			},
			now
		);
		return { kind: 'reset' };
	});
}

export type HostReset =
	{ kind: 'reset'; email: string; wasOn: boolean } | { kind: 'refused'; message: string };

/**
 * `npm run two-factor:reset -- --email <email>` (TF15): the way back in for someone with a shell
 * on the server, when the last admin has lost their phone and recovery codes. Any account; the
 * email's failed-attempt pause is cleared too.
 */
export function resetTwoFactorFromHost(
	database: AppDatabase,
	email: string,
	now: number
): HostReset {
	const user = findUserByEmail(database, email.trim().toLowerCase());
	if (user === undefined) {
		return { kind: 'refused', message: `No account has the email ${email.trim()}.` };
	}
	return database.transaction((transaction) => {
		const wasOn = isTwoFactorOn(transaction, user.id);
		removeTwoFactor(transaction, user.id);
		endChallenges(transaction, user.id);
		clearSignInFailures(transaction, user.email);
		recordAudit(
			transaction,
			{
				actor: { kind: 'system' },
				kind: 'two-factor-reset',
				target: user.email,
				machineId: null,
				detail: { how: 'from the server command line' }
			},
			now
		);
		return { kind: 'reset', email: user.email, wasOn };
	});
}
