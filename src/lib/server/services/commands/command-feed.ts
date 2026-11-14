import { COMMAND_RUN_EVENT } from '#lib/schemas/commands/commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { authenticateSession } from '../auth/current-user.ts';
import type { CommandRunner } from './command-runner.ts';
import { runViewFor } from './run-views.ts';

/**
 * A run's results page, live (SPEC-COMMANDS C16), as server-sent events like the Machines
 * feed (SPEC-PRESENCE P5). Each change is checked as it happens: the session must still be
 * valid, and the view holds only the machines the person can view now. A running machine's
 * output never goes in the feed, only its size so far: the page reads the output itself through
 * the machine's output endpoint, with its own access check (C22).
 */

const KEEP_ALIVE_MS = 25_000;
const RETRY_MS = 5_000;
const OUTPUT_EVERY_MS = 1_000;

export function runFeedStream(
	database: Queryable,
	runner: CommandRunner,
	token: string,
	runId: string
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let stop = (): void => undefined;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const write = (text: string): void => {
				if (open) {
					controller.enqueue(encoder.encode(text));
				}
			};
			const finish = (): void => {
				stop();
				controller.close();
			};
			/** Sends the run as the person may see it now; false when the feed should end. */
			const send = (): boolean => {
				const user = authenticateSession(database, token, Date.now());
				const view = user === undefined ? undefined : runViewFor(database, user, runId, runner);
				if (view === undefined) {
					return false;
				}
				write(`event: ${COMMAND_RUN_EVENT}\ndata: ${JSON.stringify(view)}\n\n`);
				return true;
			};
			const unsubscribe = runner.onChange((changed) => {
				if (changed === runId && !send()) {
					finish();
				}
			});
			// Output while a machine runs (C22) changes its byte count in the view; a busy command
			// prints many frames a second, so the view goes at most once a second for them.
			let outputTimer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribeOutput = runner.onOutput((changed) => {
				if (changed !== runId || outputTimer !== undefined) {
					return;
				}
				outputTimer = setTimeout(() => {
					outputTimer = undefined;
					if (!send()) {
						finish();
					}
				}, OUTPUT_EVERY_MS);
				outputTimer.unref();
			});
			const keepAlive = setInterval(() => {
				write(': keep-alive\n\n');
			}, KEEP_ALIVE_MS);
			keepAlive.unref();
			stop = () => {
				open = false;
				unsubscribe();
				unsubscribeOutput();
				clearTimeout(outputTimer);
				clearInterval(keepAlive);
			};
			write(`retry: ${String(RETRY_MS)}\n\n`);
			if (!send()) {
				finish();
			}
		},
		cancel() {
			stop();
		}
	});
}
