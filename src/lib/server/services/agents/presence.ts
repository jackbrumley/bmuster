import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import type { MachineStatus } from '#lib/domain/machines/machine.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { raiseNotification } from '../notifications/events.ts';

/**
 * Online and offline from the agent's live socket (SPEC-PRESENCE). An agent
 * that has held a live socket is online while it is connected, and goes
 * offline once the socket has been gone for the grace period, so a quick
 * reconnect never flickers. Going offline and coming back are recorded in
 * Activity and raised as notification events. Agents that never open a
 * socket (a proxy that blocks WebSockets) keep the check-in rule.
 *
 * Who is connected lives in memory; the database keeps only what a restart
 * needs: whether the agent has ever used the socket, and since when it has
 * been offline.
 */

/** How long a socket may be gone before its machine shows offline. */
export const PRESENCE_GRACE_MS = 60_000;

/**
 * After a restart nobody is connected yet. Agents wait up to 60 s between
 * reconnect attempts, so a machine that was online gets twice the grace.
 */
const RESTART_GRACE_MS = 2 * PRESENCE_GRACE_MS;

/** An agent without a live socket shows Offline after this many missed check-ins. */
const OFFLINE_AFTER_INTERVALS = 3;

type Presence =
	| { kind: 'connected' }
	| {
			kind: 'grace';
			/** When the socket closed (or, after a restart, when it was last seen). */
			disconnectedAt: number;
			/** When it goes offline unless it reconnects. */
			deadline: number;
			timer: ReturnType<typeof setTimeout>;
	  };

type StatusListener = (event: MachineStatusEvent) => void;

type PresenceState = {
	presences: Map<string, Presence>;
	listeners: Set<StatusListener>;
};

/** On globalThis, like live-agents.ts: the dev server can load this module more than once. */
const STATE_KEY = Symbol.for('bmuster.presence');

function presenceState(): PresenceState {
	const existing: unknown = Reflect.get(globalThis, STATE_KEY);
	if (isPresenceState(existing)) {
		return existing;
	}
	const created: PresenceState = { presences: new Map(), listeners: new Set() };
	Reflect.set(globalThis, STATE_KEY, created);
	return created;
}

function isPresenceState(value: unknown): value is PresenceState {
	return (
		typeof value === 'object' &&
		value !== null &&
		'presences' in value &&
		value.presences instanceof Map &&
		'listeners' in value &&
		value.listeners instanceof Set
	);
}

const { presences, listeners } = presenceState();

/** The columns presence reads from a machine row. */
type PresenceRow = {
	id: string;
	lastSeenAt: Date;
	checkInSeconds: number;
	socketConnectedAt: Date | null;
	socketOfflineSince: Date | null;
};

/** Online or offline, and since when (SPEC-PRESENCE P1–P4). */
export function presenceOf(machine: PresenceRow, now: number): MachineStatus {
	const live = presences.get(machine.id);
	if (live !== undefined) {
		switch (live.kind) {
			case 'connected':
				return { kind: 'online' };
			case 'grace':
				return now < live.deadline ? { kind: 'online' } : offlineSince(live.disconnectedAt);
		}
	}
	if (machine.socketOfflineSince !== null) {
		return offlineSince(machine.socketOfflineSince.getTime());
	}
	// Never used the socket: the check-in rule. Used it, but not seen by this process yet: last seen plus the grace.
	const window =
		machine.socketConnectedAt === null
			? OFFLINE_AFTER_INTERVALS * machine.checkInSeconds * 1000
			: PRESENCE_GRACE_MS;
	const lastSeen = machine.lastSeenAt.getTime();
	return now - lastSeen < window ? { kind: 'online' } : offlineSince(lastSeen);
}

function offlineSince(at: number): MachineStatus {
	return { kind: 'offline', sinceIso: new Date(at).toISOString() };
}

/** The agent's live socket opened: online, and "came back online" if it had gone offline. */
export function socketOpened(database: AppDatabase, machineId: string, now: number): void {
	const previous = presences.get(machineId);
	if (previous?.kind === 'grace') {
		clearTimeout(previous.timer);
	}
	presences.set(machineId, { kind: 'connected' });
	const cameBack = database.transaction((tx) => {
		const row = tx
			.select({
				name: machines.name,
				hostname: machines.hostname,
				socketOfflineSince: machines.socketOfflineSince
			})
			.from(machines)
			.where(eq(machines.id, machineId))
			.get();
		if (row === undefined) {
			return false;
		}
		tx.update(machines)
			.set({
				socketConnectedAt: new Date(now),
				socketOfflineSince: null,
				lastSeenAt: new Date(now)
			})
			.where(eq(machines.id, machineId))
			.run();
		if (row.socketOfflineSince === null) {
			return false;
		}
		recordAudit(
			tx,
			{
				actor: { kind: 'system' },
				kind: 'machine-online',
				target: row.name,
				machineId,
				detail: { offlineSince: row.socketOfflineSince.toISOString() }
			},
			now
		);
		raiseNotification(
			tx,
			{
				kind: 'machine-online',
				machineId,
				detail: {
					machineName: row.name,
					hostname: row.hostname,
					offlineSince: row.socketOfflineSince.toISOString()
				}
			},
			now
		);
		return true;
	});
	// A reconnect within the grace changes nothing anyone sees.
	if (cameBack || previous === undefined) {
		publish({ machineId, status: { kind: 'online' }, atIso: new Date(now).toISOString() });
	}
}

/** The agent's live socket closed: still online until the grace runs out. */
export function socketClosed(database: AppDatabase, machineId: string, now: number): void {
	database
		.update(machines)
		.set({ lastSeenAt: new Date(now) })
		.where(eq(machines.id, machineId))
		.run();
	startGrace(database, machineId, now, now + PRESENCE_GRACE_MS);
}

/**
 * At start-up: a machine whose socket was open when the server stopped has
 * not reconnected yet. It stays online for the restart grace from its last
 * contact (or from now, if that is later), rather than everything going
 * offline at once.
 */
export function restorePresence(database: AppDatabase, now: number): void {
	const rows = database
		.select({ id: machines.id, lastSeenAt: machines.lastSeenAt })
		.from(machines)
		.where(
			and(
				isNull(machines.removedAt),
				isNotNull(machines.socketConnectedAt),
				isNull(machines.socketOfflineSince)
			)
		)
		.all();
	for (const row of rows) {
		if (!presences.has(row.id)) {
			const lastSeen = row.lastSeenAt.getTime();
			startGrace(database, row.id, lastSeen, Math.max(lastSeen, now) + RESTART_GRACE_MS);
		}
	}
}

function startGrace(
	database: AppDatabase,
	machineId: string,
	disconnectedAt: number,
	deadline: number
): void {
	const previous = presences.get(machineId);
	if (previous?.kind === 'grace') {
		clearTimeout(previous.timer);
	}
	const timer = setTimeout(
		() => {
			graceEnded(database, machineId, disconnectedAt);
		},
		Math.max(0, deadline - Date.now())
	);
	timer.unref();
	presences.set(machineId, { kind: 'grace', disconnectedAt, deadline, timer });
}

/** The socket stayed away for the whole grace: offline, recorded once, since it closed. */
function graceEnded(database: AppDatabase, machineId: string, disconnectedAt: number): void {
	const presence = presences.get(machineId);
	if (presence?.kind !== 'grace' || presence.disconnectedAt !== disconnectedAt) {
		return;
	}
	presences.delete(machineId);
	const since = new Date(disconnectedAt);
	const wentOffline = database.transaction((tx) => {
		const row = tx
			.select({
				name: machines.name,
				hostname: machines.hostname,
				removedAt: machines.removedAt,
				socketOfflineSince: machines.socketOfflineSince
			})
			.from(machines)
			.where(eq(machines.id, machineId))
			.get();
		// A removed (or unknown) machine left on purpose; one already offline was recorded before.
		if (row?.removedAt !== null || row.socketOfflineSince !== null) {
			return false;
		}
		tx.update(machines).set({ socketOfflineSince: since }).where(eq(machines.id, machineId)).run();
		recordAudit(
			tx,
			{
				actor: { kind: 'system' },
				kind: 'machine-offline',
				target: row.name,
				machineId,
				detail: {}
			},
			disconnectedAt
		);
		raiseNotification(
			tx,
			{
				kind: 'machine-offline',
				machineId,
				detail: { machineName: row.name, hostname: row.hostname, offlineSince: since.toISOString() }
			},
			disconnectedAt
		);
		return true;
	});
	if (wentOffline) {
		publish({
			machineId,
			status: { kind: 'offline', sinceIso: since.toISOString() },
			atIso: new Date().toISOString()
		});
	}
}

/** Hears every status change, for the console's live feed. Returns the unsubscribe. */
export function onStatusChange(listener: StatusListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function publish(event: MachineStatusEvent): void {
	for (const listener of listeners) {
		listener(event);
	}
}
