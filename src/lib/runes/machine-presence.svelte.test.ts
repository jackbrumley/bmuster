import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineStatus } from '#lib/domain/machines/machine.ts';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { MachinePresence } from './machine-presence.svelte.ts';
import { SessionLink } from './session-link.svelte.ts';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-07T12:00:00.000Z');

function iso(atMs: number): string {
	return new Date(atMs).toISOString();
}

/** What the page has loaded; a test changes it to stand for a reload. */
let loaded: { machineId: string; status: MachineStatus; loadedAtMs: number };

beforeEach(() => {
	loaded = { machineId: MACHINE_ID, status: { kind: 'online' }, loadedAtMs: NOW };
	FakeEventSource.opened = [];
	FakeSocket.last = undefined;
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn(() =>
			Promise.resolve(
				Response.json({
					sessionId: '22222222-2222-4222-8222-222222222222',
					browserTicket: 'ticket-1'
				})
			)
		)
	);
	sessionStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

/** A terminal session on `machineId` that the server then ends with `reason`. */
async function sessionEnds(machineId: string, reason: 'agent-lost' | 'exited'): Promise<void> {
	const link = new SessionLink('terminal', machineId, {
		attached: () => undefined,
		ready: () => undefined,
		binary: () => undefined,
		text: () => undefined,
		ended: () => undefined
	});
	await link.start({ kind: 'terminal', shell: 'bash', cols: 80, rows: 24 }, 'bash');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	socket.receive(JSON.stringify({ type: 'ended', reason, message: 'Gone.' }));
}

describe("one machine's presence on its pages (SPEC-PRESENCE)", () => {
	it('P10: follows the live feed over the loaded status', () => {
		const presence = new MachinePresence(() => loaded);
		const stop = presence.connect('/api/machines/events', () => Promise.resolve());
		expect(presence.status).toEqual({ kind: 'online' });
		const offline = { kind: 'offline', sinceIso: iso(NOW + 1000) } as const;
		feed().push({ machineId: MACHINE_ID, status: offline, atIso: iso(NOW + 61_000) });
		feed().push({ machineId: OTHER_ID, status: { kind: 'online' }, atIso: iso(NOW + 62_000) });
		expect(presence.status).toEqual(offline);
		expect(presence.now).toBe(NOW + 62_000);
		stop();
	});

	it('P11: a session that lost its agent shows Reconnecting at once, until the feed or a reload says otherwise', async () => {
		const presence = new MachinePresence(() => loaded);
		const refresh = vi.fn(() => Promise.resolve());
		const stop = presence.connect('/api/machines/events', refresh);

		await sessionEnds(MACHINE_ID, 'agent-lost');
		expect(presence.status.kind).toBe('reconnecting');

		// The feed's own event, sent when the server saw the socket close, comes after.
		feed().push({ machineId: MACHINE_ID, status: { kind: 'online' }, atIso: iso(NOW + 5000) });
		expect(presence.status).toEqual({ kind: 'online' });

		await sessionEnds(MACHINE_ID, 'agent-lost');
		expect(presence.status.kind).toBe('reconnecting');
		loaded = { machineId: MACHINE_ID, status: { kind: 'online' }, loadedAtMs: NOW + 9000 };
		expect(presence.status).toEqual({ kind: 'online' });
		stop();
	});

	it('P11: ignores sessions that ended for other reasons, or on other machines', async () => {
		const presence = new MachinePresence(() => loaded);
		const stop = presence.connect('/api/machines/events', () => Promise.resolve());
		await sessionEnds(MACHINE_ID, 'exited');
		await sessionEnds(OTHER_ID, 'agent-lost');
		expect(presence.status).toEqual({ kind: 'online' });
		stop();
		// A page that has gone hears nothing.
		await sessionEnds(MACHINE_ID, 'agent-lost');
		expect(presence.status).toEqual({ kind: 'online' });
	});

	it('P11: asks the server again a little later, in case only the session went', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const presence = new MachinePresence(() => loaded);
		const refresh = vi.fn(() => Promise.resolve());
		const stop = presence.connect('/api/machines/events', refresh);
		await sessionEnds(MACHINE_ID, 'agent-lost');
		vi.advanceTimersByTime(64_999);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(refresh).toHaveBeenCalledOnce();
		stop();
	});
});
