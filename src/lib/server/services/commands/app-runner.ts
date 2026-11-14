import { database } from '../../database/app-database.ts';
import { env } from '../../env.ts';
import { sessionRelay } from '../sessions/relay.ts';
import { commandRunner, type CommandRunner } from './command-runner.ts';

/**
 * The server's command runner (SPEC-COMMANDS), on the server's database and relay: the Commands
 * routes, the MCP tools (SPEC-MCP) and start-up all reach the same runs through it.
 */
export function appRunner(): CommandRunner {
	return commandRunner({
		database,
		relay: sessionRelay(),
		secretsKey: env.secretsKey,
		clock: Date.now
	});
}
