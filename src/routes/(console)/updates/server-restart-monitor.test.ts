import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import type { ApiResult } from '#lib/utils/api-client.ts';
import { startServerRestartMonitor, type RestartReturn } from './server-restart-monitor.ts';

const VIEW: ServerUpdateView = {
	installedVersion: '0.3.1',
	deployment: 'installed',
	launcherVersion: '0.3.0',
	checkedAtIso: null,
	lastSuccessAtIso: null,
	release: null,
	problem: null,
	install: { allowed: false, reason: '' },
	operation: {
		current: '0.3.2',
		previous: '0.3.1',
		pending: '0.3.2',
		phase: 'starting',
		message: 'Starting server 0.3.2'
	}
};

function reply(
	installedVersion: string,
	phase: ServerUpdateView['operation']['phase']
): ApiResult<ServerUpdateView> {
	return {
		ok: true,
		data: {
			...VIEW,
			installedVersion,
			operation: {
				...VIEW.operation,
				current: installedVersion,
				pending: phase === 'updated' || phase === 'rolled-back' ? null : '0.3.2',
				phase
			}
		}
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('server restart monitor (SPEC-SERVER-UPDATES SU12)', () => {
	it('retries proxy failures and reloads only after the expected version is healthy', async () => {
		vi.useFakeTimers();
		const read = vi
			.fn<() => Promise<ApiResult<ServerUpdateView>>>()
			.mockResolvedValueOnce({ ok: false, message: 'Bad gateway', status: 502 })
			.mockResolvedValueOnce(reply('0.3.1', 'starting'))
			.mockResolvedValueOnce(reply('0.3.2', 'updated'));
		const onReturned = vi.fn<(result: RestartReturn) => void>();
		const monitor = startServerRestartMonitor({ expectedVersion: '0.3.2', read, onReturned });

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
			expect(onReturned.mock.calls[0][0].view.installedVersion).toBe('0.3.2');
		monitor.stop();
	});

	it.each(['failed', 'rolled-back'] as const)(
		'recognises a returned server reporting %s without waiting for the new version',
		async (phase) => {
			vi.useFakeTimers();
			const read = vi.fn(() => Promise.resolve(reply('0.3.1', phase)));
			const onReturned = vi.fn<(result: RestartReturn) => void>();
			startServerRestartMonitor({ expectedVersion: '0.3.2', read, onReturned });

			await vi.waitFor(() => {
				expect(onReturned).toHaveBeenCalledOnce();
			});
			expect(onReturned.mock.calls[0]?.[0].kind).toBe('failed');
			if (onReturned.mock.calls[0]?.[0].kind === 'failed')
				expect(onReturned.mock.calls[0][0].view.operation.phase).toBe(phase);
			expect(read).toHaveBeenCalledOnce();
		}
	);

	it('cancels future checks when the Updates page is left', async () => {
		vi.useFakeTimers();
		const read = vi.fn(() =>
			Promise.resolve({ ok: false as const, message: 'Offline', status: 0 })
		);
		const onReturned = vi.fn<(result: RestartReturn) => void>();
		const monitor = startServerRestartMonitor({ expectedVersion: '0.3.2', read, onReturned });

		await vi.waitFor(() => {
			expect(read).toHaveBeenCalledOnce();
		});
		monitor.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledOnce();
		expect(onReturned).not.toHaveBeenCalled();
	});
});
