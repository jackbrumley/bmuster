/**
 * npm run diagnostics -- machines | logs | report | checks | sessions | watch <name-or-id> | server
 *
 * Reads machine logs, reports, self-checks and session timelines and the server log with a
 * read-only diagnostics token (SPEC-AGENT-LOGS 4, SPEC-DIAGNOSTICS 5). See
 * scripts/diagnostics/cli.ts.
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
		},
		// --follow and watch run until Ctrl+C.
		wait: (ms) =>
			new Promise((resolve) => {
				setTimeout(() => {
					resolve(true);
				}, ms);
			})
	},
	Date.now()
);
