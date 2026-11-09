import type { AppDatabase } from '../../database/connection.ts';
import { processNotificationEvents } from '../notifications/notify.ts';
import { deliverDueEmails } from './email-queue.ts';
import { serverLog } from '../logs/server-log.ts';
import { sendSmtp } from './smtp.ts';

/**
 * Works through the email queue in the background (SPEC-EMAIL E3), after
 * turning waiting notification events into emails (E6): every 15 seconds, and at once when something is queued from a request. One run
 * at a time; a run that is going when another is asked for runs again after.
 * The queue is in the database, so a restart picks up where it left off.
 */
const POLL_MS = 15_000;

type Worker =
	| { kind: 'stopped' }
	| {
			kind: 'started';
			database: AppDatabase;
			secretsKey: Buffer;
			running: boolean;
			again: boolean;
	  };

let worker: Worker = { kind: 'stopped' };

function writeLog(line: string): void {
	serverLog('info', 'email', line);
}

/** Read through a function: a request for another run arrives while this one awaits. */
function wantsAnotherRun(): boolean {
	return worker.kind === 'started' && worker.again;
}

async function runOnce(): Promise<void> {
	if (worker.kind === 'stopped') {
		return;
	}
	if (worker.running) {
		worker.again = true;
		return;
	}
	const current = worker;
	current.running = true;
	try {
		do {
			current.again = false;
			processNotificationEvents(current.database, Date.now());
			const run = await deliverDueEmails(current.database, current.secretsKey, sendSmtp, () =>
				Date.now()
			);
			if (run.retrying > 0 || run.failed > 0) {
				writeLog(
					`${run.sent} sent, ${run.retrying} to retry, ${run.failed} given up (see Settings → Email)`
				);
			}
		} while (wantsAnotherRun());
	} catch (error) {
		writeLog(`The queue run stopped: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		current.running = false;
	}
}

/** Starts the worker once per process (the dev server may call init again). */
export function startEmailWorker(database: AppDatabase, secretsKey: Buffer): void {
	if (worker.kind === 'started') {
		return;
	}
	const timer = setInterval(() => void runOnce(), POLL_MS);
	timer.unref();
	worker = { kind: 'started', database, secretsKey, running: false, again: false };
	void runOnce();
}

/** Sends what was just queued without waiting for the next poll. */
export function wakeEmailWorker(): void {
	void runOnce();
}
