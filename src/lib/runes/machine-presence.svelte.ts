import { createContext } from 'svelte';
import { reconnectingEvent } from '#lib/domain/machines/machine-events.ts';
import type { MachineStatus } from '#lib/domain/machines/machine.ts';
import { LiveStatuses } from './live-statuses.svelte.ts';

/**
 * One machine's status, the same for its header and every tab (SPEC-PRESENCE
 * P10). The machine layout makes one, connects it to the live feed and
 * provides it; the tabs read `machinePresence()` instead of the status in
 * their page data, so nothing on the page can disagree.
 */

/** What the page loaded: the machine, its status then, and the server's time of the load. */
type Loaded = { machineId: string; status: MachineStatus; loadedAtMs: number };

/**
 * After a session's agent was lost, the page asks the server again once the
 * feed has had time to say whether the machine really went (a lost session
 * stream alone leaves it online). Longer than a missed agent ping.
 */
const CONFIRM_LOST_AFTER_MS = 65_000;

/** Sessions on this page that lost their agent (P11); the machine's presence listens. */
let lostListeners: ((machineId: string) => void)[] = [];

/** A session ended with `agent-lost`: the machine's presence shows Reconnecting at once (P11). */
export function announceAgentLost(machineId: string): void {
	for (const listener of lostListeners) {
		listener(machineId);
	}
}

export class MachinePresence {
	readonly #statuses = new LiveStatuses();
	readonly #loaded: () => Loaded;

	/** `loaded` reads the page data, so a reload is seen at once. */
	constructor(loaded: () => Loaded) {
		this.#loaded = loaded;
	}

	/** The status to show everywhere on the machine's pages. */
	get status(): MachineStatus {
		const loaded = this.#loaded();
		return this.#statuses.statusOf(loaded.machineId, loaded.status, loaded.loadedAtMs);
	}

	/** The newest server time the page knows, for "Offline · just now". */
	get now(): number {
		return Math.max(this.#loaded().loadedAtMs, this.#statuses.latestAtMs);
	}

	/** Follows the live feed (and lost sessions) until the returned stop is called (from `onMount`). */
	connect(url: string, refresh: () => Promise<void>): () => void {
		const stopFeed = this.#statuses.connect(url, refresh);
		let confirm: ReturnType<typeof setTimeout> | undefined;
		const onLost = (machineId: string): void => {
			if (machineId !== this.#loaded().machineId || !this.agentLost()) {
				return;
			}
			clearTimeout(confirm);
			confirm = setTimeout(() => void refresh(), CONFIRM_LOST_AFTER_MS);
		};
		lostListeners = [...lostListeners, onLost];
		return () => {
			stopFeed();
			clearTimeout(confirm);
			lostListeners = lostListeners.filter((listener) => listener !== onLost);
		};
	}

	/**
	 * Shows Reconnecting now, ahead of the feed's own event: laid over
	 * everything the page knows so far, so any later event or reload replaces
	 * it. False when the machine was not showing online anyway.
	 */
	agentLost(): boolean {
		const { machineId } = this.#loaded();
		if (this.status.kind !== 'online') {
			return false;
		}
		this.#statuses.apply(reconnectingEvent(machineId, this.now + 1));
		return true;
	}
}

const [getPresence, setPresence] = createContext<MachinePresence>();

/** For the machine layout: makes its presence what every tab below reads. */
export function provideMachinePresence(presence: MachinePresence): void {
	setPresence(presence);
}

/** The open machine's presence, for its tabs (during component set-up). */
export function machinePresence(): MachinePresence {
	return getPresence();
}
