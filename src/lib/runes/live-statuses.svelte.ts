import { SvelteMap } from 'svelte/reactivity';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import type { MachineStatus } from '#lib/domain/machines/machine.ts';
import {
	MACHINE_STATUS_EVENT,
	machineStatusEventSchema
} from '#lib/schemas/machines/machine-events.ts';
import { apiEvents } from '#lib/utils/api-client.ts';

/**
 * Machine status as it changes (SPEC-PRESENCE P5), for the Machines list and
 * the machine header. The page keeps its loaded data; a pushed status is laid
 * over it only while it is newer than that data, so a later reload wins.
 * Without the push (no EventSource, or the stream refused) the page is
 * reloaded every 15 seconds instead, while it is visible.
 */

/** How often the page reloads its data when the live feed is not available. */
const FALLBACK_REFRESH_MS = 15_000;

export class LiveStatuses {
	#pushed = new SvelteMap<string, { status: MachineStatus; atMs: number }>();

	/** The server time of the newest event, for "Offline · just now" (0 before any). */
	latestAtMs = $state(0);

	/** The status to show: the pushed one when it is newer than the page's data. */
	statusOf(machineId: string, loaded: MachineStatus, loadedAtMs: number): MachineStatus {
		const pushed = this.#pushed.get(machineId);
		return pushed !== undefined && pushed.atMs > loadedAtMs ? pushed.status : loaded;
	}

	apply(event: MachineStatusEvent): void {
		const atMs = Date.parse(event.atIso);
		this.#pushed.set(event.machineId, { status: event.status, atMs });
		this.latestAtMs = Math.max(this.latestAtMs, atMs);
	}

	/**
	 * Listens to `url` (GET /api/machines/events) until the returned stop is
	 * called (from `onMount`). `refresh` reloads the page's data: after a
	 * dropped stream comes back, and on the fallback timer.
	 */
	connect(url: string, refresh: () => Promise<void>): () => void {
		let fallback: ReturnType<typeof setInterval> | undefined;
		const stop = apiEvents({
			url,
			event: MACHINE_STATUS_EVENT,
			reply: machineStatusEventSchema,
			onEvent: (event) => {
				this.apply(event);
			},
			onReconnect: () => {
				void refresh();
			},
			onFailure: () => {
				fallback ??= setInterval(() => {
					if (document.visibilityState === 'visible') {
						void refresh();
					}
				}, FALLBACK_REFRESH_MS);
			}
		});
		return () => {
			stop();
			clearInterval(fallback);
		};
	}
}
