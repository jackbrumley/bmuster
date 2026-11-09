/**
 * npm run diagnostics -- machines | logs <name-or-id> | report <name-or-id> | server
 *
 * Reads machine logs, machine reports and the server log with a read-only diagnostics token
 * (SPEC-AGENT-LOGS 4). See scripts/diagnostics/cli.ts.
 */
import { homedir } from 'node:os';
import { runDiagnostics } from './diagnostics/cli.ts';

process.exitCode = await runDiagnostics(
	process.argv.slice(2),
	{
		env: process.env,
		home: homedir(),
		platform: process.platform,
		fetch: globalThis.fetch,
		out: (line) => {
			console.log(line);
		},
		err: (line) => {
			console.error(line);
		}
	},
	Date.now()
);
