/**
 * node scripts/account-recovery.ts reset-password | reset-two-factor --email <email>
 *
 * The way back in for someone with a shell on the server (see scripts/account-recovery/cli.ts).
 * From a checkout it runs as `npm run admin:reset` and `npm run two-factor:reset`; the release
 * bundle carries it as app/account-recovery.js, which `bmuster-server reset-password` and
 * `reset-two-factor` run with the installed server's settings and data.
 */
import { openDatabase } from '../src/lib/server/database/connection.ts';
import { env } from '../src/lib/server/env.ts';
import { runAccountRecovery } from './account-recovery/cli.ts';

process.exitCode = await runAccountRecovery(
	process.argv.slice(2),
	() => openDatabase(env.databasePath),
	{
		out: (line) => {
			console.log(line);
		},
		err: (line) => {
			console.error(line);
		}
	},
	Date.now()
);
