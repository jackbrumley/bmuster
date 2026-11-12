import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import FilesInLayout from './files-in-layout.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));
vi.mock('$app/state', () => ({
	page: { url: new URL('https://bmuster.test/machines/11111111-1111-4111-8111-111111111111/files') }
}));

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const SINCE = '2026-11-07T11:00:00.000Z';

const OFFLINE: Machine = { ...TEST_MACHINE, status: { kind: 'offline', sinceIso: SINCE } };

beforeEach(async () => {
	await page.viewport(390, 844);
	sessionStorage.clear();
	FakeEventSource.opened = [];
	refreshAll.mockClear();
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input, location.origin);
			return Promise.resolve(
				url.pathname.endsWith('/files/list')
					? Response.json({
							path: '/',
							entries: [
								{
									name: 'srv',
									kind: 'folder',
									size: 0,
									modifiedMs: NOW,
									hidden: false,
									linkTarget: null
								}
							],
							more: false
						})
					: Response.json({ message: 'Not here.' }, { status: 404 })
			);
		})
	);
});

function openFiles(machine: Machine) {
	return render(FilesInLayout, {
		pageProps: {
			params: { id: machine.id },
			data: {
				user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
				localNetworkMode: false,
				serverUpdate: null,
				signedIn: true,
				now: NOW,
				machine,
				grants: [
					{ permission: 'view', consent: 'unattended' },
					{ permission: 'files', consent: 'unattended' }
				]
			}
		}
	});
}

describe('one status on a machine page (SPEC-PRESENCE P10)', () => {
	it('P10: the header and the tab say the same, and the tab opens when the machine comes back', async () => {
		const screen = await openFiles(OFFLINE);
		const header = screen.getByRole('banner');
		await expect.element(header.getByText(/Offline · /)).toBeVisible();
		await expect.element(screen.getByText('This machine is offline.')).toBeVisible();

		feed().push({
			machineId: OFFLINE.id,
			status: { kind: 'online' },
			atIso: new Date(NOW + 5000).toISOString()
		});
		await expect.element(header.getByText('Online')).toBeVisible();
		await expect.element(screen.getByRole('list', { name: 'Files in /' })).toBeVisible();
		await expect.element(screen.getByText('This machine is offline.')).not.toBeInTheDocument();
	});

	it('P9, P10: when the socket closes, both say Reconnecting at once, then Offline', async () => {
		const screen = await openFiles(TEST_MACHINE);
		const header = screen.getByRole('banner');
		await expect.element(screen.getByRole('list', { name: 'Files in /' })).toBeVisible();

		const closedAt = new Date(NOW + 1000).toISOString();
		feed().push({
			machineId: TEST_MACHINE.id,
			status: { kind: 'reconnecting', sinceIso: closedAt },
			atIso: closedAt
		});
		await expect.element(header.getByText('Reconnecting')).toBeVisible();
		await expect.element(screen.getByText('This machine is reconnecting.')).toBeVisible();

		feed().push({
			machineId: TEST_MACHINE.id,
			status: { kind: 'offline', sinceIso: closedAt },
			atIso: new Date(NOW + 61_000).toISOString()
		});
		await expect.element(header.getByText(/Offline · /)).toBeVisible();
		await expect.element(screen.getByText('This machine is offline.')).toBeVisible();
	});
});
