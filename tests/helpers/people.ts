import type { AppDatabase } from '#lib/server/database/connection.ts';
import type { ConsoleRole } from '#lib/domain/users/user.ts';
import type { SignInClient } from '#lib/server/services/auth/client.ts';
import { hashPassword } from '#lib/server/services/auth/passwords.ts';
import { insertUser, type UserRow } from '#lib/server/services/users/users.ts';

export const NOW = 1_794_000_000_000;

export const CLIENT: SignInClient = { ip: '192.0.2.10', userAgent: 'Vitest' };

export const PASSWORD = 'correct horse battery';

/** A user straight into the database, with a password unless `password` is null. */
export async function addTestUser(
	database: AppDatabase,
	options: { email: string; role: ConsoleRole; password: string | null }
): Promise<UserRow> {
	return insertUser(
		database,
		{
			name: options.email.split('@')[0] ?? options.email,
			email: options.email,
			role: options.role,
			passwordHash: options.password === null ? null : await hashPassword(options.password)
		},
		NOW
	);
}
