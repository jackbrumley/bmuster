/**
 * Account recovery from the server's own shell (SPEC-SIGN-IN S19, SPEC-TWO-FACTOR TF15,
 * SPEC-SERVER-INSTALL I15): the one entry behind `npm run admin:reset`, `npm run
 * two-factor:reset`, `bmuster-server reset-password | reset-two-factor` on an installed server
 * and the image's `bmuster-server` for `docker exec`.
 *
 * Whoever can run it can already read the server's settings and database, so it asks nothing
 * more of them. It writes beside the running server like any second SQLite connection (write-ahead
 * log, busy timeout); it never takes the server's data lock. Every change is audited with actor
 * system by the services it calls.
 */
import { parseArgs } from 'node:util';
import type { AppDatabase } from '../../src/lib/server/database/connection.ts';
import { resetAdminPassword } from '../../src/lib/server/services/auth/admin-reset.ts';
import { resetTwoFactorFromHost } from '../../src/lib/server/services/auth/two-factor-reset.ts';

export type RecoveryIo = {
	out: (line: string) => void;
	err: (line: string) => void;
};

const USAGE = `Usage: bmuster-server reset-password --email <admin email>
       bmuster-server reset-two-factor --email <email>

  reset-password     sets a new password for an enabled admin, prints it once, ends their sessions
  reset-two-factor   turns off two-factor sign-in for any account

From a source checkout: npm run admin:reset -- --email <admin email>
                        npm run two-factor:reset -- --email <email>`;

type Request =
	| { kind: 'reset-password'; email: string }
	| { kind: 'reset-two-factor'; email: string }
	| { kind: 'usage'; problem: string };

function parse(argv: readonly string[]): Request {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: { email: { type: 'string' } },
			allowPositionals: true,
			strict: true
		});
	} catch (error) {
		return { kind: 'usage', problem: error instanceof Error ? error.message : String(error) };
	}
	const { values, positionals } = parsed;
	const [command, ...extra] = positionals;
	if (command !== 'reset-password' && command !== 'reset-two-factor') {
		return {
			kind: 'usage',
			problem: command === undefined ? 'Name a command.' : `Unknown command ${command}.`
		};
	}
	if (extra.length > 0) {
		return { kind: 'usage', problem: `Unexpected ${extra.join(' ')}.` };
	}
	const email = values.email?.trim() ?? '';
	if (email === '') {
		return { kind: 'usage', problem: 'Give the account with --email <email>.' };
	}
	return { kind: command, email };
}

/**
 * Runs one command and returns the process exit code: 0 done, 1 refused or misused (nothing
 * changed). The database is opened only for a well-formed command.
 */
export async function runAccountRecovery(
	argv: readonly string[],
	open: () => AppDatabase,
	io: RecoveryIo,
	now: number
): Promise<number> {
	const request = parse(argv);
	switch (request.kind) {
		case 'usage':
			io.err(request.problem);
			io.err(USAGE);
			return 1;
		case 'reset-password': {
			const result = await resetAdminPassword(open(), request.email, now);
			if (result.kind === 'refused') {
				io.err(`reset-password: ${result.message}`);
				return 1;
			}
			io.out(`New password for ${result.email} (shown once; their sessions have ended):`);
			io.out('');
			io.out(`    ${result.password}`);
			io.out('');
			io.out('Sign in with it, then set a password of your own from the Users page.');
			return 0;
		}
		case 'reset-two-factor': {
			const result = resetTwoFactorFromHost(open(), request.email, now);
			if (result.kind === 'refused') {
				io.err(`reset-two-factor: ${result.message}`);
				return 1;
			}
			io.out(
				result.wasOn
					? `Two-factor sign-in is off for ${result.email}. They sign in with their password; if the server requires two-factor, they set it up again straight away.`
					: `${result.email} did not have two-factor sign-in on; any half-finished set-up was cleared.`
			);
			return 0;
		}
	}
}
