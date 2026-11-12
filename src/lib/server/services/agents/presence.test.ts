import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import { done } from '#tests/helpers/access.ts';
import { setUpEmail } from '#tests/helpers/email.ts';
import { enrolFakeAgent, NO_RELEASES, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { emailMessages, machines, notificationEvents } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { listAuditForMachines } from '../audit/audit.ts';
import { findMachine, removeMachine } from '../machines/machine-views.ts';
import { createRule } from '../notifications/notification-rules.ts';
import { processNotificationEvents } from '../notifications/notify.ts';
import {
	onStatusChange,
	PRESENCE_GRACE_MS,
	restorePresence,
	socketClosed,
	socketOpened,
	unreachableMessage
} from './presence.ts';

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
	vi.useRealTimers();
});

function statusAt(database: AppDatabase, machineId: string, at: number) {
	return findMachine(database, machineId, at, NO_RELEASES)?.status;
}

/** The presence entries in the audit log, oldest first. */
function presenceAudit(database: AppDatabase, machineId: string) {
	return listAuditForMachines(database, [machineId], 100)
		.filter((entry) => entry.kind === 'machine-offline' || entry.kind === 'machine-online')
		.reverse()
		.map((entry) => ({ kind: entry.kind, at: entry.at.getTime(), machineId }));
}

function raisedEvents(database: AppDatabase) {
	return database
		.select()
		.from(notificationEvents)
		.all()
		.map((event) => ({ kind: event.kind, machineId: event.machineId }));
}

/** Every status change published while `run` runs. */
function published(run: () => void): MachineStatusEvent[] {
	const events: MachineStatusEvent[] = [];
	const stop = onStatusChange((event) => events.push(event));
	try {
		run();
	} finally {
		stop();
	}
	return events;
}

describe('presence from the live socket (SPEC-PRESENCE)', () => {
	it('P1: is online while the socket is open, whatever the last check-in', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		vi.advanceTimersByTime(3_600_000);
		expect(statusAt(database, machineId, Date.now())).toEqual({ kind: 'online' });
	});

	it('P2, P9: shows reconnecting at once, then offline once the socket has been gone for the 60 s grace, since it closed', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		const closedAt = NOW + 1000;
		vi.setSystemTime(closedAt);
		const closing = published(() => {
			socketClosed(database, machineId, closedAt);
		});
		const reconnecting = { kind: 'reconnecting', sinceIso: new Date(closedAt).toISOString() };
		expect(closing).toEqual([
			{ machineId, status: reconnecting, atIso: new Date(closedAt).toISOString() }
		]);

		vi.advanceTimersByTime(PRESENCE_GRACE_MS - 1);
		expect(statusAt(database, machineId, Date.now())).toEqual(reconnecting);
		expect(presenceAudit(database, machineId)).toEqual([]);

		const events = published(() => {
			vi.advanceTimersByTime(1);
		});
		const offline = { kind: 'offline', sinceIso: new Date(closedAt).toISOString() };
		expect(statusAt(database, machineId, Date.now())).toEqual(offline);
		expect(events).toEqual([
			{ machineId, status: offline, atIso: new Date(closedAt + PRESENCE_GRACE_MS).toISOString() }
		]);
		expect(presenceAudit(database, machineId)).toEqual([
			{ kind: 'machine-offline', at: closedAt, machineId }
		]);
		expect(raisedEvents(database)).toContainEqual({ kind: 'machine-offline', machineId });
	});

	it('P3, P9: a reconnect within the grace is a blip: reconnecting, then online, and nothing recorded', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		const events = published(() => {
			socketClosed(database, machineId, NOW);
			vi.advanceTimersByTime(30_000);
			socketOpened(database, machineId, Date.now());
			vi.advanceTimersByTime(10 * PRESENCE_GRACE_MS);
		});
		expect(events).toEqual([
			{
				machineId,
				status: { kind: 'reconnecting', sinceIso: new Date(NOW).toISOString() },
				atIso: new Date(NOW).toISOString()
			},
			{ machineId, status: { kind: 'online' }, atIso: new Date(NOW + 30_000).toISOString() }
		]);
		expect(statusAt(database, machineId, Date.now())).toEqual({ kind: 'online' });
		expect(presenceAudit(database, machineId)).toEqual([]);
		expect(raisedEvents(database).filter((event) => event.kind !== 'machine-enrolled')).toEqual([]);
	});

	it('P2, P6: coming back after going offline is recorded and published once', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		socketClosed(database, machineId, NOW);
		vi.advanceTimersByTime(PRESENCE_GRACE_MS);
		vi.advanceTimersByTime(600_000);
		const backAt = Date.now();
		const events = published(() => {
			socketOpened(database, machineId, backAt);
		});
		expect(events).toEqual([
			{ machineId, status: { kind: 'online' }, atIso: new Date(backAt).toISOString() }
		]);
		expect(statusAt(database, machineId, backAt)).toEqual({ kind: 'online' });
		expect(presenceAudit(database, machineId)).toEqual([
			{ kind: 'machine-offline', at: NOW, machineId },
			{ kind: 'machine-online', at: backAt, machineId }
		]);
		expect(raisedEvents(database)).toContainEqual({ kind: 'machine-online', machineId });
		// Its next blip is a blip again.
		socketClosed(database, machineId, backAt);
		socketOpened(database, machineId, backAt + 5000);
		vi.advanceTimersByTime(10 * PRESENCE_GRACE_MS);
		expect(presenceAudit(database, machineId)).toHaveLength(2);
	});

	it('P7, P9: an agent that never opened a socket keeps the check-in rule, never reconnecting, with no entries', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		expect(statusAt(database, machineId, NOW + 179_000)).toEqual({ kind: 'online' });
		expect(statusAt(database, machineId, NOW + 180_000)).toEqual({
			kind: 'offline',
			sinceIso: new Date(NOW).toISOString()
		});
		vi.advanceTimersByTime(3_600_000);
		expect(presenceAudit(database, machineId)).toEqual([]);
	});

	it('P4, P9: after a restart, a machine that was connected shows reconnecting for twice the grace, then goes offline since it was last seen', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		// What the stopped server left behind: the socket open, nobody in memory.
		database
			.update(machines)
			.set({ socketConnectedAt: new Date(NOW), lastSeenAt: new Date(NOW) })
			.where(eq(machines.id, machineId))
			.run();
		const restartedAt = NOW + 600_000;
		vi.setSystemTime(restartedAt);
		restorePresence(database, restartedAt);

		vi.advanceTimersByTime(2 * PRESENCE_GRACE_MS - 1);
		expect(statusAt(database, machineId, Date.now())).toEqual({
			kind: 'reconnecting',
			sinceIso: new Date(NOW).toISOString()
		});
		vi.advanceTimersByTime(1);
		expect(statusAt(database, machineId, Date.now())).toEqual({
			kind: 'offline',
			sinceIso: new Date(NOW).toISOString()
		});
		expect(presenceAudit(database, machineId)).toEqual([
			{ kind: 'machine-offline', at: NOW, machineId }
		]);
	});

	it('P4: after a restart, a machine that reconnects in time records nothing; one that was offline stays offline', () => {
		const database = testDatabase();
		const back = enrolFakeAgent(database, NOW).machineId;
		const gone = enrolFakeAgent(database, NOW).machineId;
		database
			.update(machines)
			.set({ socketConnectedAt: new Date(NOW) })
			.where(eq(machines.id, back))
			.run();
		database
			.update(machines)
			.set({ socketConnectedAt: new Date(NOW), socketOfflineSince: new Date(NOW - 5000) })
			.where(eq(machines.id, gone))
			.run();
		restorePresence(database, NOW);

		expect(statusAt(database, gone, NOW)).toEqual({
			kind: 'offline',
			sinceIso: new Date(NOW - 5000).toISOString()
		});
		vi.advanceTimersByTime(20_000);
		socketOpened(database, back, Date.now());
		vi.advanceTimersByTime(10 * PRESENCE_GRACE_MS);
		expect(statusAt(database, back, Date.now())).toEqual({ kind: 'online' });
		expect(presenceAudit(database, back)).toEqual([]);
	});

	it('P4: without the in-memory state, a socket agent is judged by last seen plus the grace', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		database
			.update(machines)
			.set({ socketConnectedAt: new Date(NOW), lastSeenAt: new Date(NOW) })
			.where(eq(machines.id, machineId))
			.run();
		expect(statusAt(database, machineId, NOW + PRESENCE_GRACE_MS - 1)).toEqual({ kind: 'online' });
		expect(statusAt(database, machineId, NOW + PRESENCE_GRACE_MS)).toEqual({
			kind: 'offline',
			sinceIso: new Date(NOW).toISOString()
		});
	});

	it('P9: a newer connection replacing an open one publishes nothing', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		const events = published(() => {
			socketOpened(database, machineId, NOW + 1000);
		});
		expect(events).toEqual([]);
	});

	it('P9: a session refused while the socket is gone says reconnecting during the grace, offline after it', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		socketClosed(database, machineId, NOW);
		expect(unreachableMessage(machineId, NOW + PRESENCE_GRACE_MS - 1)).toBe(
			'This machine is reconnecting. Try again in a moment.'
		);
		vi.advanceTimersByTime(PRESENCE_GRACE_MS);
		expect(unreachableMessage(machineId, Date.now())).toBe('This machine is offline.');
	});

	it('records nothing for a machine removed during the grace', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		socketClosed(database, machineId, NOW);
		removeMachine(database, machineId, crypto.randomUUID(), NOW + 1000);
		const events = published(() => {
			vi.advanceTimersByTime(PRESENCE_GRACE_MS);
		});
		expect(events).toEqual([]);
		expect(presenceAudit(database, machineId)).toEqual([]);
	});
});

describe('presence notifications (SPEC-PRESENCE P6)', () => {
	async function setUp() {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.test',
			role: 'admin',
			password: PASSWORD
		});
		setUpEmail(database, admin.id, 2525);
		return { database, admin };
	}

	function goOfflineAndBack(database: AppDatabase): void {
		const { machineId } = enrolFakeAgent(database, NOW);
		socketOpened(database, machineId, NOW);
		socketClosed(database, machineId, NOW);
		vi.advanceTimersByTime(PRESENCE_GRACE_MS);
		socketOpened(database, machineId, Date.now());
	}

	it('emails nobody unless a rule picks the event', async () => {
		const { database } = await setUp();
		goOfflineAndBack(database);
		expect(processNotificationEvents(database, Date.now())).toBe(0);
		expect(database.select().from(emailMessages).all()).toEqual([]);
	});

	it('emails a rule that picks Machine went offline, and one that picks Machine came back online', async () => {
		const { database, admin } = await setUp();
		for (const eventKind of ['machine-offline', 'machine-online'] as const) {
			done(
				createRule(
					database,
					admin.id,
					{
						eventKind,
						scope: { kind: 'any-machine' },
						recipients: { kind: 'addresses', addresses: [`${eventKind}@example.test`] },
						enabled: true
					},
					NOW
				)
			);
		}
		goOfflineAndBack(database);
		expect(processNotificationEvents(database, Date.now())).toBe(2);
		const subjects = database
			.select()
			.from(emailMessages)
			.all()
			.map((message) => `${message.toAddress}: ${message.subject}`)
			.sort();
		expect(subjects).toEqual([
			'machine-offline@example.test: Offline: Test machine',
			'machine-online@example.test: Back online: Test machine'
		]);
	});
});
