import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { hasUsers, insertUser, markSignedIn, toConsoleUser } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { hashPassword } from './passwords.ts';
import { startSession, type StartedSession } from './sessions.ts';

/**
 * First run (SPEC-SIGN-IN S1): while there are no users, /setup makes the
 * first admin and signs them in. The check and the insert share one
 * transaction, so two people racing for /setup cannot both become admin.
 */
export type SetupResult =
	{ kind: 'created'; user: ConsoleUser; session: StartedSession } | { kind: 'closed' };

export async function setupFirstAdmin(
	database: AppDatabase,
	input: { name: string; email: string; password: string },
	client: SignInClient,
	now: number
): Promise<SetupResult> {
	if (hasUsers(database)) {
		return { kind: 'closed' };
	}
	const passwordHash = await hashPassword(input.password);
	return database.transaction((transaction): SetupResult => {
		if (hasUsers(transaction)) {
			return { kind: 'closed' };
		}
		const user = insertUser(
			transaction,
			{ name: input.name, email: input.email, role: 'admin', passwordHash },
			now
		);
		markSignedIn(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'setup',
				target: user.email,
				detail: { ip: client.ip }
			},
			now
		);
		const session = startSession(transaction, user.id, client, now);
		return { kind: 'created', user: toConsoleUser(user), session };
	});
}
