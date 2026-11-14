/**
 * npm run two-factor:reset -- --email <email>
 *
 * The way back in when someone (often the last admin) has lost both their phone and their
 * recovery codes (SPEC-TWO-FACTOR TF15). Run it on the server, as someone who can read its
 * .env and database, like admin:reset. It removes that account's two-factor sign-in, clears the
 * email's failed-attempt pause and records it in Activity. If the server requires two-factor
 * for them, they set it up again straight after their password. Unknown emails exit with 1.
 */
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/server/database/connection.ts';
import { env } from '../src/lib/server/env.ts';
import { resetTwoFactorFromHost } from '../src/lib/server/services/auth/two-factor-reset.ts';

const { values } = parseArgs({ options: { email: { type: 'string' } } });

if (values.email === undefined || values.email.trim() === '') {
	console.error('Usage: npm run two-factor:reset -- --email <email>');
	process.exit(1);
}

const result = resetTwoFactorFromHost(openDatabase(env.databasePath), values.email, Date.now());
if (result.kind === 'refused') {
	console.error(`two-factor:reset: ${result.message}`);
	process.exit(1);
}
console.log(
	result.wasOn
		? `Two-factor sign-in is off for ${result.email}. They sign in with their password; if the server requires two-factor, they set it up again straight away.`
		: `${result.email} did not have two-factor sign-in on; any half-finished set-up was cleared.`
);
