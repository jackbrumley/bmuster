import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import { LiveStatuses } from './live-statuses.svelte.ts';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const ONLINE = { kind: 'online' } as const;

function iso(atMs: number): string {
	return new Date(atMs).toISOString();
}

beforeEach(() => {
	FakeEventSource.opened = [];
	vi.stubGlobal('EventSource', FakeEventSource);
});

describe('live machine status in the browser (SPEC-PRESENCE)', () => {
	it('P5, P9: lays a pushed status over the loaded one only while it is newer', () => {
		const statuses = new LiveStatuses();
		const reconnecting = { kind: 'reconnecting', sinceIso: iso(NOW + 1000) } as const;
		statuses.apply({ machineId: MACHINE_ID, status: reconnecting, atIso: iso(NOW + 1000) });
		expect(statuses.statusOf(MACHINE_ID, ONLINE, NOW)).toEqual(reconnecting);
		// A reload after the event knows better.
		expect(statuses.statusOf(MACHINE_ID, ONLINE, NOW + 2000)).toEqual(ONLINE);
		expect(statuses.latestAtMs).toBe(NOW + 1000);
	});

	it('P12: a page shown again after being hidden reloads once and opens a fresh feed', () => {
		const refresh = vi.fn(() => Promise.resolve());
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		const stop = new LiveStatuses().connect('/api/machines/events', refresh);
		const first = feed();

		// Shown without having been hidden: nothing to catch up on.
		document.dispatchEvent(new Event('visibilitychange'));
		expect(refresh).not.toHaveBeenCalled();

		visibility.mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		visibility.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(refresh).toHaveBeenCalledOnce();
		expect(first.readyState).toBe(FakeEventSource.CLOSED);
		expect(FakeEventSource.opened).toHaveLength(2);
		expect(feed().readyState).toBe(1);

		stop();
		expect(feed().readyState).toBe(FakeEventSource.CLOSED);
		visibility.mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		visibility.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('P12: the network coming back reloads once and opens a fresh feed', () => {
		const refresh = vi.fn(() => Promise.resolve());
		const stop = new LiveStatuses().connect('/api/machines/events', refresh);
		window.dispatchEvent(new Event('online'));
		expect(refresh).toHaveBeenCalledOnce();
		expect(FakeEventSource.opened).toHaveLength(2);
		expect(FakeEventSource.opened[0]?.readyState).toBe(FakeEventSource.CLOSED);
		stop();
	});

	it('P12: a feed opened again after a refusal takes over from the fallback timer', () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const refresh = vi.fn(() => Promise.resolve());
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
			const stop = new LiveStatuses().connect('/api/machines/events', refresh);
			feed().refuse();
			vi.advanceTimersByTime(15_000);
			expect(refresh).toHaveBeenCalledOnce();
			window.dispatchEvent(new Event('online'));
			expect(refresh).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(60_000);
			expect(refresh).toHaveBeenCalledTimes(2);
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
