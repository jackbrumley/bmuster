import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { FileEntry } from '#lib/domain/files/files.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
import FilesTab from './+page.svelte';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';

const LINUX: Machine = TEST_MACHINE;

const GRANTS: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'files', consent: 'unattended' }
];

function entry(name: string, kind: FileEntry['kind'], size: number): FileEntry {
	return {
		name,
		kind,
		size,
		modifiedMs: Date.parse('2026-11-01T09:30:00Z'),
		hidden: name.startsWith('.'),
		linkTarget: kind === 'link' ? '/etc/hosts' : null
	};
}

const FOLDERS: Record<string, { entries: FileEntry[]; more: boolean }> = {
	'/': {
		entries: [
			entry('srv', 'folder', 0),
			entry('notes.txt', 'file', 2048),
			entry('.profile', 'file', 10),
			entry('hosts', 'link', 0)
		],
		more: false
	},
	'/srv': { entries: [entry('backup.zip', 'file', 1024 ** 3)], more: true }
};

const requests: { method: string; url: URL; body: unknown }[] = [];

beforeEach(async () => {
	await page.viewport(390, 844);
	sessionStorage.clear();
	requests.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string, init: RequestInit) => {
			const url = new URL(input, location.origin);
			const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
			requests.push({ method: init.method ?? 'GET', url, body });
			const reply = (json: unknown, status = 200) =>
				Promise.resolve(Response.json(json, { status }));
			if (url.pathname.endsWith('/files/roots')) {
				return reply({
					roots: [
						{
							path: 'C:\\',
							label: 'Local disk',
							kind: 'drive',
							totalBytes: 500 * 1024 ** 3,
							freeBytes: 120 * 1024 ** 3
						},
						{
							path: 'D:\\',
							label: 'Network drive',
							kind: 'drive',
							totalBytes: null,
							freeBytes: null
						}
					]
				});
			}
			if (url.pathname.endsWith('/files/list')) {
				const path = url.searchParams.get('path') ?? '';
				const folder = FOLDERS[path];
				return folder === undefined
					? reply({ message: `${path} does not exist.` }, 404)
					: reply({ path, ...folder });
			}
			if (url.pathname.endsWith('/files/delete')) {
				const names = (body as { names: string[] }).names;
				return reply({ removed: names, items: names.length, failed: [] });
			}
			if (url.pathname.endsWith('/files/folder')) {
				return reply({ path: '/new' });
			}
			return reply({ message: 'Not here.' }, 404);
		})
	);
});

afterEach(() => {
	// A question left open would open the next test's dialog over everything.
	if (confirmation.current.kind === 'asking') {
		confirmation.current.answer({ kind: 'no' });
	}
});

async function openTab(machine: Machine, grants: Grant[] = GRANTS) {
	await render(ConfirmDialog);
	const props = {
		params: { id: machine.id },
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: false,
			assistant: { kind: 'none' as const },
			signedIn: true,
			now: Date.parse('2026-11-07T12:00:00.000Z'),
			machine,
			grants
		}
	};
	return render(FilesTab, props, underMachineLayout(presenceOf(machine, props.data.now)));
}

describe('the Files tab (SPEC-FILES F3, F9)', () => {
	it('opens / on Linux: folders first, sizes and dates, hidden entries hidden, links as links', async () => {
		const screen = await openTab(LINUX);
		const list = screen.getByRole('list', { name: 'Files in /' });
		await expect.element(list).toBeVisible();
		const rows = list.getByRole('listitem');
		await expect
			.poll(() => rows.elements().map((row) => row.textContent.trim().split(/\s+/)[0]))
			.toEqual(['srv', 'hosts', 'notes.txt']);
		await expect.element(list.getByText(/^2\.0 KB · /)).toBeVisible();
		await expect.element(list.getByText('Link to /etc/hosts', { exact: false })).toBeVisible();
		await screen.getByRole('checkbox', { name: 'Show hidden' }).click();
		await expect.element(list.getByText('.profile')).toBeVisible();
	});

	it('opens a folder, shows the breadcrumbs and says when a listing was cut short', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('button', { name: /^srv/ }).click();
		await expect.element(screen.getByRole('list', { name: 'Files in /srv' })).toBeVisible();
		const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
		await expect.element(crumbs.getByRole('button', { name: 'Disks' })).toBeVisible();
		await expect
			.element(crumbs.getByRole('button', { name: 'srv' }))
			.toHaveAttribute('aria-current', 'location');
		await expect.element(screen.getByText(/Showing the first 5,000 entries/)).toBeVisible();
		await crumbs.getByRole('button', { name: '/' }).click();
		await expect.element(screen.getByRole('list', { name: 'Files in /' })).toBeVisible();
	});

	it('starts at the drives on Windows, with free-space bars (F2)', async () => {
		const screen = await openTab({ ...LINUX, osFamily: 'windows' });
		await expect.element(screen.getByRole('button', { name: /C:\\/ })).toBeVisible();
		await expect
			.element(screen.getByRole('meter', { name: 'Local disk' }))
			.toHaveAttribute('aria-valuenow', '76');
		await expect.element(screen.getByText('120 GB free of 500 GB')).toBeVisible();
		await expect.element(screen.getByText('Network drive')).toBeVisible();
	});

	it('opens a sheet for a file with Download, Rename and Delete', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('button', { name: /notes\.txt/ }).click();
		const sheet = screen.getByRole('dialog', { name: 'notes.txt' });
		await expect.element(sheet.getByText('/notes.txt')).toBeVisible();
		for (const name of ['Download', 'Rename', 'Delete']) {
			await expect.element(sheet.getByRole('button', { name })).toBeVisible();
		}
	});

	it('ticks rows into a bar with Download, Delete and Clear, and Select all ticks them all', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('checkbox', { name: 'Select notes.txt' }).click();
		const bar = screen.getByRole('toolbar', { name: 'Selected items' });
		await expect.element(bar.getByText('1 selected')).toBeVisible();
		await screen.getByRole('checkbox', { name: 'Select all' }).click();
		await expect.element(bar.getByText('3 selected')).toBeVisible();
		await bar.getByRole('button', { name: 'Clear' }).click();
		await expect.element(bar).not.toBeInTheDocument();
	});

	it('deletes several at once, asking for the typed confirmation when a folder is among them (F7)', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('checkbox', { name: 'Select srv' }).click();
		await screen.getByRole('checkbox', { name: 'Select notes.txt' }).click();
		await screen
			.getByRole('toolbar', { name: 'Selected items' })
			.getByRole('button', { name: 'Delete' })
			.click();
		const dialog = screen.getByRole('dialog', { name: 'Delete 2 items?' });
		await expect.element(dialog.getByText(/deleted with everything in them/)).toBeVisible();
		await dialog.getByRole('button', { name: 'Delete' }).click();
		expect(requests.some((request) => request.url.pathname.endsWith('/delete'))).toBe(false);
		await dialog.getByRole('textbox', { name: /^Type the name above to confirm/ }).fill('delete 2');
		await dialog.getByRole('button', { name: 'Delete' }).click();
		await expect
			.poll(() => requests.find((request) => request.url.pathname.endsWith('/delete'))?.body)
			.toEqual({ dir: '/', names: ['srv', 'notes.txt'], recursive: true });
	});

	it('deletes files alone with a plain confirmation and no recursion', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('checkbox', { name: 'Select hosts' }).click();
		await screen
			.getByRole('toolbar', { name: 'Selected items' })
			.getByRole('button', { name: 'Delete' })
			.click();
		const dialog = screen.getByRole('dialog', { name: 'Delete “hosts”?' });
		await expect
			.element(dialog.getByText(/A link is deleted, not what it points to/))
			.toBeVisible();
		await dialog.getByRole('button', { name: 'Delete' }).click();
		await expect
			.poll(() => requests.find((request) => request.url.pathname.endsWith('/delete'))?.body)
			.toEqual({ dir: '/', names: ['hosts'], recursive: false });
	});

	it('checks a new folder name before asking the machine', async () => {
		const screen = await openTab(LINUX);
		await screen.getByRole('button', { name: 'New folder' }).click();
		const dialog = screen.getByRole('dialog', { name: 'New folder' });
		await dialog.getByRole('textbox', { name: /^Folder name/ }).fill('a:b');
		await dialog.getByRole('button', { name: 'Make folder' }).click();
		await expect.element(dialog.getByText('A name cannot contain a colon.')).toBeVisible();
		await dialog.getByRole('textbox', { name: /^Folder name/ }).fill('Reports');
		await dialog.getByRole('button', { name: 'Make folder' }).click();
		await expect
			.poll(() => requests.find((request) => request.url.pathname.endsWith('/folder'))?.body)
			.toEqual({ dir: '/', name: 'Reports' });
	});
});

describe('when Files cannot open (F11)', () => {
	it('says the machine is offline', async () => {
		const screen = await openTab({
			...LINUX,
			status: { kind: 'offline', sinceIso: '2026-11-07T11:00:00.000Z' }
		});
		await expect.element(screen.getByText('This machine is offline.')).toBeVisible();
		expect(requests).toEqual([]);
	});

	it('says why a folder could not be opened, with Try again', async () => {
		sessionStorage.setItem(`bmuster.files.${LINUX.id}`, '/gone');
		const screen = await openTab(LINUX);
		await expect.element(screen.getByText('Could not open this folder.')).toBeVisible();
		await expect.element(screen.getByText('/gone does not exist.')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
	});
});
