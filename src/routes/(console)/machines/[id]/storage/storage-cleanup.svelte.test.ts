import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { CleanupRun } from '#lib/domain/storage/cleanup.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import CleanupPanel from './cleanup-panel.svelte';
import { storageApi } from './storage-api.ts';

const GB = 1024 ** 3;
const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let run: CleanupRun;
const requests: { method: string; url: URL; body: unknown }[] = [];

beforeEach(async () => {
	await page.viewport(390, 844);
	requests.length = 0;
	run = { kind: 'none' };
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string, init: RequestInit) => {
			const url = new URL(input, location.origin);
			const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
			requests.push({ method: init.method ?? 'GET', url, body });
			const reply = (json: unknown, status = 200) =>
				Promise.resolve(Response.json(json, { status }));
			if (url.pathname.endsWith('/storage/cleanup/items')) {
				return reply({
					items: [
						{ id: 'old-var-tmp', size: { kind: 'bytes', bytes: 2 * GB, files: 4210 } },
						{ id: 'journal', size: { kind: 'bytes', bytes: GB, files: 12 } },
						{ id: 'unused-flatpaks', size: { kind: 'unknown' } }
					]
				});
			}
			if (url.pathname.endsWith('/storage/cleanup') && init.method === 'POST') {
				run = {
					kind: 'running',
					runId: RUN_ID,
					startedAtMs: Date.now(),
					items: [
						{ id: 'old-var-tmp', state: { kind: 'running', freedBytes: GB, filesRemoved: 2000 } },
						{ id: 'unused-flatpaks', state: { kind: 'waiting' } }
					]
				};
				return reply({ runId: RUN_ID });
			}
			if (url.pathname.endsWith('/storage/cleanup')) {
				return reply({ run });
			}
			return reply({ message: 'Not here.' }, 404);
		})
	);
});

function openPanel() {
	return render(CleanupPanel, { api: storageApi(TEST_MACHINE.id) });
}

const starts = () => requests.filter((request) => request.method === 'POST');

describe('the Clean up panel (SPEC-STORAGE S20)', () => {
	it('measures first, then totals what is ticked', async () => {
		const screen = await openPanel();
		await screen.getByRole('button', { name: 'Find what can be cleaned up' }).click();
		const list = screen.getByRole('list', { name: 'Items to clean up' });
		await expect.element(list.getByText('2.0 GB in 4,210 files')).toBeVisible();
		await expect
			.element(list.getByText('Frees an unknown amount, can take several minutes'))
			.toBeVisible();
		await expect.element(list.getByText(/nobody has read or changed for 30 days/)).toBeVisible();
		await expect.element(screen.getByText('Nothing selected')).toBeVisible();
		await list.getByRole('checkbox', { name: 'Old files in /var/tmp' }).click();
		await list.getByRole('checkbox', { name: 'Unused Flatpak runtimes' }).click();
		await expect
			.element(screen.getByText('2 items, 2.0 GB plus an unknown amount selected'))
			.toBeVisible();
	});

	it('sends nothing without ticking and confirming', async () => {
		const screen = await openPanel();
		await screen.getByRole('button', { name: 'Find what can be cleaned up' }).click();
		await screen.getByRole('button', { name: 'Clean up' }).click();
		expect(confirmation.current.kind).toBe('none');
		await screen.getByRole('checkbox', { name: 'System journal over 200 MB' }).click();
		await screen.getByRole('button', { name: 'Clean up' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') {
			expect(confirmation.current.options.title).toBe('Clean up 1 item?');
			expect(confirmation.current.options.message).toContain(
				'System journal over 200 MB: 1.0 GB in 12 files.'
			);
			confirmation.current.answer({ kind: 'no' });
		}
		expect(starts()).toEqual([]);
	});

	it('starts with the ticked ids only, then shows progress and results', async () => {
		const screen = await openPanel();
		await screen.getByRole('button', { name: 'Find what can be cleaned up' }).click();
		await screen.getByRole('checkbox', { name: 'Old files in /var/tmp' }).click();
		await screen.getByRole('checkbox', { name: 'Unused Flatpak runtimes' }).click();
		await screen.getByRole('button', { name: 'Clean up' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') {
			confirmation.current.answer({ kind: 'yes', password: '' });
		}
		await expect
			.poll(() => starts().map((request) => request.body))
			.toEqual([{ items: ['old-var-tmp', 'unused-flatpaks'] }]);
		const progress = screen.getByRole('list', { name: 'Clean-up progress' });
		await expect.element(progress.getByText('Cleaning… 1.0 GB freed so far')).toBeVisible();
		run = {
			kind: 'finished',
			runId: RUN_ID,
			startedAtMs: 1,
			finishedAtMs: 2,
			items: [
				{
					id: 'old-var-tmp',
					state: {
						kind: 'done',
						result: {
							freedBytes: 2 * GB,
							measured: 'counted',
							filesRemoved: 4100,
							filesSkipped: 110,
							errors: 0,
							messages: []
						}
					}
				},
				{
					id: 'unused-flatpaks',
					state: {
						kind: 'done',
						result: {
							freedBytes: 0,
							measured: 'free-space',
							filesRemoved: 0,
							filesSkipped: 0,
							errors: 1,
							messages: ['flatpak ended with exit status: 1.']
						}
					}
				}
			]
		};
		await expect
			.element(progress.getByText('Freed 2.0 GB · 4,100 files removed · 110 skipped'), {
				timeout: 6000
			})
			.toBeVisible();
		await expect.element(progress.getByText('flatpak ended with exit status: 1.')).toBeVisible();
		await expect.element(screen.getByText(/Freed 2.0 GB in all/)).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Measure again' })).toBeVisible();
	});

	it('opens on a clean-up still running, and says when one was cut off', async () => {
		run = {
			kind: 'running',
			runId: RUN_ID,
			startedAtMs: 1,
			items: [{ id: 'journal', state: { kind: 'waiting' } }]
		};
		const screen = await openPanel();
		await expect.element(screen.getByText('Waiting')).toBeVisible();
		run = { ...run, kind: 'interrupted' };
		await expect
			.element(screen.getByText('The clean-up stopped before the end.'), { timeout: 6000 })
			.toBeVisible();
	});
});
