/**
 * npm run admin:reset -- --email <email>
 *
 * Break-glass (SPEC-SIGN-IN S19): run on the server, as someone who can read
 * its .env and database, to get back into an admin account. Sets a new random
 * password for an enabled admin, prints it once, ends their sessions and
 * records it in Activity. Refuses members and unknown emails (exit code 1).
 */
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/server/database/connection.ts';
import { env } from '../src/lib/server/env.ts';
import { resetAdminPassword } from '../src/lib/server/services/auth/admin-reset.ts';

const { values } = parseArgs({ options: { email: { type: 'string' } } });

if (values.email === undefined || values.email.trim() === '') {
	console.error('Usage: npm run admin:reset -- --email <admin email>');
	process.exit(1);
}

const result = await resetAdminPassword(openDatabase(env.databasePath), values.email, Date.now());
if (result.kind === 'refused') {
	console.error(`admin:reset: ${result.message}`);
	process.exit(1);
}
console.log(`New password for ${result.email} (shown once; their sessions have ended):`);
console.log(`\n    ${result.password}\n`);
console.log('Sign in with it, then set a password of your own from the Users page.');
