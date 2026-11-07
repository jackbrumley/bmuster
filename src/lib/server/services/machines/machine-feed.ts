import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import { MACHINE_STATUS_EVENT } from '#lib/schemas/machines/machine-events.ts';
import type { Queryable } from '../../database/connection.ts';
import { canSeeMachine } from '../access/access.ts';
import { onStatusChange } from '../agents/presence.ts';
import { authenticateSession } from '../auth/current-user.ts';

/**
 * The console's live feed of machine status (SPEC-PRESENCE P5), sent as
 * server-sent events. Each event is checked as it happens: the session must
 * still be valid (a signed-out or disabled person's feed ends) and the person
 * must be able to see the machine now, so a member never hears about a
 * machine they cannot see, even after their access changes.
 */

/** A comment line this often keeps proxies from closing an idle stream. */
const KEEP_ALIVE_MS = 25_000;

/** How long a browser waits before reconnecting a dropped stream. */
const RETRY_MS = 5_000;

/** Status events the session behind `token` may see; `end` runs when the session has ended. */
export function machineFeed(
	database: Queryable,
	token: string,
	send: (event: MachineStatusEvent) => void,
	end: () => void
): () => void {
	const unsubscribe = onStatusChange((event) => {
		const user = authenticateSession(database, token, Date.now());
		if (user === undefined) {
			unsubscribe();
			end();
			return;
		}
		if (canSeeMachine(database, user, event.machineId)) {
			send(event);
		}
	});
	return unsubscribe;
}

/** The feed as a `text/event-stream` body; it stops when the browser goes away. */
export function machineFeedStream(database: Queryable, token: string): ReadableStream<Uint8Array> {
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
			const unsubscribe = machineFeed(
				database,
				token,
				(event) => {
					write(`event: ${MACHINE_STATUS_EVENT}\ndata: ${JSON.stringify(event)}\n\n`);
				},
				() => {
					stop();
					controller.close();
				}
			);
			const keepAlive = setInterval(() => {
				write(': keep-alive\n\n');
			}, KEEP_ALIVE_MS);
			keepAlive.unref();
			stop = () => {
				open = false;
				unsubscribe();
				clearInterval(keepAlive);
			};
			write(`retry: ${String(RETRY_MS)}\n\n`);
		},
		cancel() {
			stop();
		}
	});
}
