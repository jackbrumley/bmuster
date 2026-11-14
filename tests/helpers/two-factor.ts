import { eq } from 'drizzle-orm';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { totpAuthenticators } from '#lib/server/database/schema.ts';
import { openSecret } from '#lib/server/crypto/secret-box.ts';
import { totpCode } from '#lib/server/crypto/totp.ts';
import { confirmTotpSetUp, startTotpSetUp } from '#lib/server/services/auth/two-factor.ts';
import type { UserRow } from '#lib/server/services/users/users.ts';
import { SECRETS_KEY } from './email.ts';
import { CLIENT, PASSWORD } from './people.ts';

/** The code a person's authenticator app shows at `at` (ms), read from their sealed key. */
export function codeFor(database: AppDatabase, userId: string, at: number): string {
	const row = database
		.select()
		.from(totpAuthenticators)
		.where(eq(totpAuthenticators.userId, userId))
		.get();
	if (row === undefined) {
		throw new Error(`No authenticator for ${userId}`);
	}
	return totpCode(openSecret(row.secretSealed, SECRETS_KEY), Math.floor(at / 1000));
}

/** Turns two-factor on for someone (as on the Account page) and returns their recovery codes. */
export async function turnOnTwoFactor(
	database: AppDatabase,
	user: UserRow,
	at: number
): Promise<string[]> {
	const started = startTotpSetUp(database, SECRETS_KEY, user, at);
	if (started.kind !== 'started') throw new Error(started.message);
	const result = await confirmTotpSetUp(
		database,
		SECRETS_KEY,
		user,
		{ code: codeFor(database, user.id, at), password: { kind: 'given', password: PASSWORD } },
		{ ip: CLIENT.ip, where: 'account' },
		at
	);
	if (result.kind !== 'on') throw new Error(result.message);
	return result.recoveryCodes;
}
