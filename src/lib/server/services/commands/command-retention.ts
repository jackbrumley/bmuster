import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { serverLog } from '../logs/server-log.ts';
import {
	closeUnfinishedMachines,
	deleteOutputBefore,
	endRun,
	findRun,
	unfinishedRunIds
} from './command-runs.ts';

/**
 * Keeping command runs tidy (SPEC-COMMANDS C16): output is deleted 30 days after a machine
 * finished (the row, exit code, size and hash stay), and runs a restart cut off are closed.
 */

const EVERY_MS = 60 * 60 * 1000;

/** C16: deletes stdout and stderr older than 30 days; how many machines' output went. */
export function pruneCommandOutput(database: Queryable, now: number): number {
	return deleteOutputBefore(database, now - COMMAND_LIMITS.outputKeptMs, now);
}

/** Start-up: prune now and every hour after, like the logs. */
export function scheduleCommandOutputRetention(database: Queryable): void {
	const run = (): void => {
		const pruned = pruneCommandOutput(database, Date.now());
		if (pruned > 0) {
			serverLog(
				'info',
				'sessions',
				`Deleted the output of ${pruned} commands run more than 30 days ago.`
			);
		}
	};
	run();
	setInterval(run, EVERY_MS).unref();
}

/**
 * Start-up: a run lives in the server's memory, so one the restart cut off ends here. Machines
 * still running are lost (their agents stop with the socket); waiting ones never start.
 */
export function closeRunsCutByRestart(database: Queryable, now: number): number {
	const runIds = unfinishedRunIds(database);
	for (const runId of runIds) {
		closeUnfinishedMachines(database, runId, 'running', 'lost', 'The server restarted.', now);
		closeUnfinishedMachines(
			database,
			runId,
			'waiting',
			'skipped',
			'The server restarted before its turn.',
			now
		);
		endRun(
			database,
			runId,
			findRun(database, runId)?.status === 'cancelled' ? 'cancelled' : 'finished',
			now
		);
	}
	return runIds.length;
}
