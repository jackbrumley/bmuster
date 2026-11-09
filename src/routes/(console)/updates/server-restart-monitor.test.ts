import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	ServerUpdateOperation,
	ServerUpdateView
} from '#lib/schemas/releases/server-updates.ts';
import type { ApiResult } from '#lib/utils/api-client.ts';
import { startServerRestartMonitor, type RestartReturn } from './server-restart-monitor.ts';

const REQUESTED_AT = '2026-11-09T10:00:00.000Z';
const AFTER = '2026-11-09T10:01:00.000Z';
const BEFORE = '2026-11-08T10:00:00.000Z';

const VIEW: ServerUpdateView = {
	installedVersion: '0.4.0',
	deployment: 'installed',
	checkedAtIso: null,
	lastSuccessAtIso: null,
	release: null,
	problem: null,
	install: { allowed: false, reason: '' },
	operation: {
		phase: 'starting',
		from: '0.4.0',
		to: '0.4.1',
		message: 'Starting',
		atIso: AFTER
	}
};

function reply(
	installedVersion: string,
	phase: ServerUpdateOperation['phase'],
	atIso: string = AFTER
): ApiResult<ServerUpdateView> {
	return {
		ok: true,
		data: { ...VIEW, installedVersion, operation: { ...VIEW.operation, phase, atIso } }
	};
}

function monitor(read: () => Promise<ApiResult<ServerUpdateView>>) {
	const onReturned = vi.fn<(result: RestartReturn) => void>();
	const handle = startServerRestartMonitor({
		expectedVersion: '0.4.1',
		requestedAtIso: REQUESTED_AT,
		read,
		onReturned
	});
	return { onReturned, handle };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('server restart monitor (SPEC-SERVER-UPDATES SU9)', () => {
	it('retries proxy failures and reloads only after the updater reports the new version healthy', async () => {
		vi.useFakeTimers();
		const read = vi
			.fn<() => Promise<ApiResult<ServerUpdateView>>>()
			.mockResolvedValueOnce({ ok: false, message: 'Bad gateway', status: 502 })
			.mockResolvedValueOnce(reply('0.4.0', 'downloading'))
			.mockResolvedValueOnce(reply('0.4.1', 'healthy'));
		const { onReturned, handle } = monitor(read);

		await vi.waitFor(() => {
			expect(read).toHaveBeenCalledTimes(1);
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(read).toHaveBeenCalledTimes(2);
		expect(onReturned).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(read).toHaveBeenCalledTimes(3);
		expect(onReturned).toHaveBeenCalledOnce();
		expect(onReturned.mock.calls[0]?.[0].kind).toBe('ready');
		if (onReturned.mock.calls[0]?.[0].kind === 'ready')
			expect(onReturned.mock.calls[0][0].view.installedVersion).toBe('0.4.1');
		handle.stop();
	});

	it.each(['failed', 'rolled-back', 'up-to-date'] as const)(
		'recognises an updater result of %s from after the request without waiting for the new version',
		async (phase) => {
			vi.useFakeTimers();
			const read = vi.fn(() => Promise.resolve(reply('0.4.0', phase)));
			const { onReturned } = monitor(read);

			await vi.waitFor(() => {
				expect(onReturned).toHaveBeenCalledOnce();
			});
			expect(onReturned.mock.calls[0]?.[0].kind).toBe('failed');
			if (onReturned.mock.calls[0]?.[0].kind === 'failed')
				expect(onReturned.mock.calls[0][0].view.operation.phase).toBe(phase);
			expect(read).toHaveBeenCalledOnce();
		}
	);

	it('ignores a result left by an earlier update', async () => {
		vi.useFakeTimers();
		const read = vi
			.fn<() => Promise<ApiResult<ServerUpdateView>>>()
			.mockResolvedValueOnce(reply('0.4.0', 'rolled-back', BEFORE))
			.mockResolvedValueOnce(reply('0.4.0', 'healthy', BEFORE))
			.mockResolvedValueOnce(reply('0.4.1', 'healthy'));
		const { onReturned, handle } = monitor(read);
		await vi.waitFor(() => {
			expect(read).toHaveBeenCalledTimes(1);
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(onReturned).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(onReturned).toHaveBeenCalledOnce();
		expect(onReturned.mock.calls[0]?.[0].kind).toBe('ready');
		handle.stop();
	});

	it('cancels future checks when the Updates page is left', async () => {
		vi.useFakeTimers();
		const read = vi.fn(() =>
			Promise.resolve({ ok: false as const, message: 'Offline', status: 0 })
		);
		const { onReturned, handle } = monitor(read);

		await vi.waitFor(() => {
			expect(read).toHaveBeenCalledOnce();
		});
		handle.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledOnce();
		expect(onReturned).not.toHaveBeenCalled();
	});
});
