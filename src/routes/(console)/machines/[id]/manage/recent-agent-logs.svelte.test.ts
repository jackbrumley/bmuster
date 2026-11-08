import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RecentAgentLogs from './recent-agent-logs.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

describe('Manage tab: recent agent logs (SPEC-AGENT-LOGS)', () => {
	it('fetches only on request, renders logs as text and keeps old data when refresh fails', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						agentVersion: '0.3.1',
						capturedAtIso: '2026-11-08T00:00:00.000Z',
						lines: ['<script>not markup</script>'],
						truncated: false,
						journal: { kind: 'available', lines: ['terminal failed with 208'], truncated: false }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: 'The agent did not return diagnostics.' }), {
					status: 504,
					headers: { 'content-type': 'application/json' }
				})
			);
		vi.stubGlobal('fetch', fetch);

		const screen = await render(RecentAgentLogs, { machineId: MACHINE_ID });
		expect(fetch).not.toHaveBeenCalled();
		await screen.getByRole('button', { name: 'Refresh diagnostics' }).click();
		await expect.element(screen.getByText('<script>not markup</script>')).toBeVisible();
		await expect.element(screen.getByText('terminal failed with 208')).toBeVisible();
		expect(screen.container.querySelector('script')).toBeNull();
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: clipboardWrite }
		});
		const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagnostics');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement
		): void {
			this.dataset['clicked'] = 'true';
		});
		await screen.getByRole('button', { name: 'Copy all' }).click();
		await vi.waitFor(() => {
			expect(clipboardWrite).toHaveBeenCalledOnce();
		});
		expect(clipboardWrite.mock.calls[0]?.[0]).toContain('terminal failed with 208');
		await screen.getByRole('button', { name: 'Download text' }).click();
		await expect.poll(() => createObjectUrl.mock.calls.length).toBe(1);
		await expect.poll(() => anchorClick.mock.calls.length).toBe(1);
		const file = createObjectUrl.mock.calls[0]?.[0];
		expect(file).toBeInstanceOf(Blob);
		if (!(file instanceof Blob)) throw new Error('diagnostics download was not a Blob');
		await expect(file.text()).resolves.toContain('terminal failed with 208');

		await screen.getByRole('button', { name: 'Refresh diagnostics' }).click();
		await expect.poll(() => fetch.mock.calls.length).toBe(2);
		await expect.element(screen.getByText(/The agent did not return diagnostics/)).toBeVisible();
		await expect.element(screen.getByText('<script>not markup</script>')).toBeVisible();
		await expect
			.element(screen.getByText(/Previous diagnostics are still shown below/))
			.toBeVisible();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
