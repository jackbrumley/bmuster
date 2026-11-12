import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import type {
	DriveSummary,
	FolderView,
	ReportedStorage,
	StorageSummary
} from '#lib/domain/storage/storage.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import StorageTab from './+page.svelte';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';

const HOUR = 3_600_000;
const GB = 1024 ** 3;

const GRANTS: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'files', consent: 'unattended' }
];

function scanned(mount: string, hoursAgo: number): DriveSummary {
	const finishedAtMs = Date.now() - hoursAgo * HOUR;
	return {
		mount,
		sizeBytes: 100 * GB,
		freeBytes: 4 * GB,
		lastScan: {
			kind: 'complete',
			startedAtMs: finishedAtMs - HOUR,
			finishedAtMs,
			scannedBytes: 90 * GB,
			usedBytes: 96 * GB,
			files: 1000,
			folders: 200,
			denied: 0
		},
		scanning: { kind: 'idle' }
	};
}

const NEW_DRIVE: DriveSummary = {
	mount: '/home',
	sizeBytes: 50 * GB,
	freeBytes: 25 * GB,
	lastScan: { kind: 'none' },
	scanning: { kind: 'running', startedAtMs: Date.now(), percent: 42 }
};

function folder(path: string, children: FolderView['children'], more: boolean): FolderView {
	return {
		mount: '/',
		path,
		finishedAtMs: Date.now() - 3 * HOUR,
		bytes: 90 * GB,
		files: 1000,
		ownBytes: GB,
		ownFiles: 12,
		foldedFolders: 30,
		foldedBytes: 2 * GB,
		notScannedBytes: path === '/' ? 6 * GB : 0,
		children,
		offset: 0,
		more
	};
}

const FOLDERS: Record<string, FolderView> = {
	'/': folder(
		'/',
		[
			{ name: 'var', path: '/var', bytes: 60 * GB, files: 800, hasChildren: true },
			{ name: 'home', path: '/home', bytes: 27 * GB, files: 188, hasChildren: true }
		],
		false
	),
	'/var': folder(
		'/var',
		[{ name: 'log', path: '/var/log', bytes: 58 * GB, files: 40, hasChildren: false }],
		true
	)
};

let summary: StorageSummary;
let rescanReply: unknown;
const requests: { method: string; url: URL }[] = [];

beforeEach(async () => {
	await page.viewport(390, 844);
	sessionStorage.clear();
	requests.length = 0;
	summary = { drives: [scanned('/', 3), NEW_DRIVE], problem: { kind: 'none' } };
	rescanReply = {};
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string, init: RequestInit) => {
			const url = new URL(input, location.origin);
			requests.push({ method: init.method ?? 'GET', url });
			const reply = (json: unknown, status = 200) =>
				Promise.resolve(Response.json(json, { status }));
			if (url.pathname.endsWith('/storage/summary')) {
				return reply(summary);
			}
			if (url.pathname.endsWith('/storage/folder')) {
				const shown = FOLDERS[url.searchParams.get('path') ?? ''];
				const offset = Number(url.searchParams.get('offset'));
				if (shown === undefined) {
					return reply({ message: 'No separate total for this folder.' }, 404);
				}
				return offset > 0
					? reply({
							...shown,
							offset,
							more: false,
							children: [
								{ name: 'cache', path: '/var/cache', bytes: GB, files: 3, hasChildren: false }
							]
						})
					: reply(shown);
			}
			if (url.pathname.endsWith('/storage/largest')) {
				return reply({
					files: [{ path: '/var/log/huge.log', bytes: 50 * GB, modifiedMs: Date.now() }]
				});
			}
			if (url.pathname.endsWith('/storage/rescan')) {
				return reply(rescanReply);
			}
			if (url.pathname.endsWith('/storage/cleanup')) {
				return reply({ run: { kind: 'none' } });
			}
			return reply({ message: 'Not here.' }, 404);
		})
	);
});

async function openTab(
	machine: Machine,
	grants: Grant[] = GRANTS,
	reported: ReportedStorage = { kind: 'none' }
) {
	const now = Date.now();
	return render(
		StorageTab,
		{
			params: { id: machine.id },
			form: undefined,
			data: {
				user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
				localNetworkMode: false,
				serverUpdate: null,
				signedIn: true,
				now,
				machine,
				grants,
				reported
			}
		},
		underMachineLayout(presenceOf(machine, now))
	);
}

describe('the Storage tab (SPEC-STORAGE S10)', () => {
	it('lists the drives with how full they are and how fresh their scan is', async () => {
		const screen = await openTab(TEST_MACHINE);
		const drives = screen.getByRole('list', { name: 'Drives' });
		await expect
			.element(drives.getByRole('meter', { name: 'Used on /' }))
			.toHaveAttribute('aria-valuenow', '96');
		await expect.element(drives.getByText('4.0 GB free of 100 GB')).toBeVisible();
		await expect.element(drives.getByText('Scanned 3 h ago')).toBeVisible();
		await expect.element(drives.getByText('Scanning… 42 %')).toBeVisible();
	});

	it('drills down level by level, with breadcrumbs back up and more on request', async () => {
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: /Used on \/ / }).click();
		const root = screen.getByRole('list', { name: 'Space in /' });
		await expect.element(root.getByText('var')).toBeVisible();
		await expect.element(root.getByText('30 small folders')).toBeVisible();
		await expect.element(root.getByText('Not scanned')).toBeVisible();
		await expect.element(screen.getByText(/From the scan finished 3 h ago/)).toBeVisible();
		await root.getByRole('button', { name: /^var/ }).click();
		const varList = screen.getByRole('list', { name: 'Space in /var' });
		await expect.element(varList.getByText('log')).toBeVisible();
		await screen.getByRole('button', { name: 'Show more' }).click();
		await expect.element(varList.getByText('cache')).toBeVisible();
		await expect.element(varList.getByText('Files in this folder')).toBeVisible();
		const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
		await expect
			.element(crumbs.getByRole('button', { name: 'var' }))
			.toHaveAttribute('aria-current', 'location');
		await crumbs.getByRole('button', { name: 'Drives' }).click();
		await expect.element(screen.getByRole('list', { name: 'Drives' })).toBeVisible();
	});

	it('shows the largest files under the folder', async () => {
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: /Used on \/ / }).click();
		await screen.getByRole('button', { name: 'Largest files' }).click();
		const list = screen.getByRole('list', { name: 'Largest files in /' });
		await expect.element(list.getByText('huge.log')).toBeVisible();
		await expect.element(list.getByText('/var/log', { exact: true })).toBeVisible();
		await expect.element(list.getByText('50.0 GB')).toBeVisible();
	});

	it('says a drive is not scanned yet, with the progress of its first scan', async () => {
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: /Used on \/home/ }).click();
		await expect.element(screen.getByText('Scanning… 42 %')).toBeVisible();
		await expect.element(screen.getByText(/builds slowly in the background/)).toBeVisible();
		expect(requests.some((request) => request.url.pathname.endsWith('/storage/folder'))).toBe(
			false
		);
	});

	it('asks for a rescan, and shows a scan that could not be saved', async () => {
		summary = {
			...summary,
			problem: { kind: 'failed', message: 'The scan of / could not be saved: disk full', atMs: 1 }
		};
		const screen = await openTab(TEST_MACHINE);
		await expect.element(screen.getByText('The last scan could not be saved.')).toBeVisible();
		await screen.getByRole('button', { name: 'Rescan now' }).click();
		await expect
			.poll(
				() => requests.find((request) => request.url.pathname.endsWith('/storage/rescan'))?.method
			)
			.toBe('POST');
	});

	it('shows the last reported drives while the machine is offline', async () => {
		const screen = await openTab(
			{ ...TEST_MACHINE, status: { kind: 'offline', sinceIso: new Date().toISOString() } },
			GRANTS,
			{ kind: 'reported', drives: [scanned('/', 5)], reportedAt: new Date().toISOString() }
		);
		await expect.element(screen.getByText('This machine is offline.')).toBeVisible();
		await expect.element(screen.getByText('Scanned 5 h ago')).toBeVisible();
		expect(requests).toEqual([]);
	});

	it('says why without the files permission', async () => {
		const screen = await openTab(TEST_MACHINE, [{ permission: 'view', consent: 'unattended' }]);
		await expect.element(screen.getByText("You don't have permission for this.")).toBeVisible();
		expect(requests).toEqual([]);
	});

	it('S22: warns that a drive is nearly full, above the drives', async () => {
		const screen = await openTab(TEST_MACHINE);
		await expect.element(screen.getByText('Disk nearly full')).toBeVisible();
		await expect.element(screen.getByText('/ is 96 % full, 4.0 GB free.')).toBeVisible();
	});

	it('S27: Rescan now shows at once that it is asking, until the scan shows', async () => {
		summary = { drives: [scanned('/', 3)], problem: { kind: 'none' } };
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: 'Rescan now' }).click();
		await expect.element(screen.getByText('Asking Reception PC to scan…')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Rescan now' }))
			.not.toBeInTheDocument();
		summary = {
			drives: [
				{ ...scanned('/', 3), scanning: { kind: 'running', startedAtMs: Date.now(), percent: 1 } }
			],
			problem: { kind: 'none' }
		};
		await expect
			.element(screen.getByText('Scans run slowly in the background, about once a day.'), {
				timeout: 5000
			})
			.toBeVisible();
		await expect.element(screen.getByText(/scanning again, 1 %/)).toBeVisible();
	});

	it('S27: says plainly when the machine has not started the scan after a minute', async () => {
		summary = { drives: [scanned('/', 3)], problem: { kind: 'none' } };
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: 'Rescan now' }).click();
		await expect.element(screen.getByText('Asking Reception PC to scan…')).toBeVisible();
		const later = Date.now() + 61_000;
		vi.spyOn(Date, 'now').mockReturnValue(later);
		await expect
			.element(screen.getByText('The machine has not started the scan yet; it will when it can.'), {
				timeout: 5000
			})
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Rescan now' })).toBeVisible();
	});

	it('S27: says when a scan is already running, with its progress', async () => {
		rescanReply = { alreadyScanning: true };
		const screen = await openTab(TEST_MACHINE);
		await screen.getByRole('button', { name: 'Rescan now' }).click();
		await expect.element(screen.getByText('Already scanning, 42 %.')).toBeVisible();
	});
});
