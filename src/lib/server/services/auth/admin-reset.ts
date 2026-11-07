import { randomBytes } from 'node:crypto';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserByEmail, setPasswordHash } from '../users/users.ts';
import { hashPassword } from './passwords.ts';
import { endSessionsForUser } from './sessions.ts';
import { clearSignInFailures } from './sign-in-limits.ts';

/**
 * `npm run admin:reset -- --email <email>` (SPEC-SIGN-IN S19): the way back in
 * for someone with a shell on the server. Only an enabled admin; admins can
 * always use a password (break-glass), so one is set even if they had none.
 * Their sessions end and the email's failed-attempt pause is cleared.
 */
export type AdminReset =
	{ kind: 'reset'; email: string; password: string } | { kind: 'refused'; message: string };

export async function resetAdminPassword(
	database: AppDatabase,
	email: string,
	now: number
): Promise<AdminReset> {
	const user = findUserByEmail(database, email.trim());
	if (user === undefined) {
		return { kind: 'refused', message: `No account has the email ${email.trim()}.` };
	}
	if (user.role !== 'admin') {
		return {
			kind: 'refused',
			message: `${user.email} is a member, not an admin. An admin resets members' passwords on the Users page.`
		};
	}
	if (user.disabledAt !== null) {
		return {
			kind: 'refused',
			message: `${user.email} is disabled. Use another admin's account, or enable this one first.`
		};
	}
	// 18 random bytes: 24 characters of base64url, 144 bits.
	const password = randomBytes(18).toString('base64url');
	const passwordHash = await hashPassword(password);
	database.transaction((transaction) => {
		setPasswordHash(transaction, user.id, passwordHash);
		endSessionsForUser(transaction, user.id);
		clearSignInFailures(transaction, user.email);
		recordAudit(
			transaction,
			{
				actor: { kind: 'system' },
				kind: 'user-password-set',
				target: user.email,
				detail: { how: 'reset from the server command line' }
			},
			now
		);
	});
	return { kind: 'reset', email: user.email, password };
}
