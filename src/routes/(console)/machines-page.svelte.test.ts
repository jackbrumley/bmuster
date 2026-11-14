import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import MachinesPage from './+page.svelte';
import type { PageData } from './$types';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll, goto }));

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

function machine(overrides: Partial<Machine> & Pick<Machine, 'id' | 'name'>): Machine {
	return {
		description: '',
		hostname: overrides.name.toLowerCase().replaceAll(' ', '-'),
		osFamily: 'linux',
		target: 'x86_64-unknown-linux-gnu',
		agentVersion: '0.2.0',
		update: { kind: 'up-to-date' },
		status: { kind: 'online' },
		lastUser: { kind: 'none' },
		live: { kind: 'none' },
		inventory: { kind: 'pending' },
		enrolledIso: '2026-11-01T00:00:00.000Z',
		lastSeenIso: '2026-11-07T12:00:00.000Z',
		inUse: [],
		lowDisk: [],
		...overrides
	};
}

const MACHINES: Machine[] = [
	machine({
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Reception PC',
		description: 'Front desk, label 14',
		osFamily: 'windows',
		lastUser: { kind: 'user', name: 'sarah.k', seenIso: '2026-11-05T12:00:00.000Z' }
	}),
	machine({
		id: '22222222-2222-4222-8222-222222222222',
		name: 'Build server',
		hostname: 'build-01'
	})
];

/** `count` machines named Machine 001, Machine 002…, alternating online and offline. */
function fleet(count: number): Machine[] {
	return Array.from({ length: count }, (_, index) => {
		const number = String(index + 1).padStart(3, '0');
		return machine({
			id: `00000000-0000-4000-8000-000000000${number}`,
			name: `Machine ${number}`,
			status:
				index % 2 === 0
					? { kind: 'online' }
					: { kind: 'offline', sinceIso: '2026-11-06T12:00:00.000Z' }
		});
	});
}

type Rollout = PageData['rollout'];

function renderPage(machines: Machine[] = MACHINES, rollout: Rollout = { kind: 'none' }) {
	return render(MachinesPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: false,
			assistant: { kind: 'none' },
			signedIn: true,
			now: NOW,
			rollout,
			view: { kind: 'machines', machines },
			commands: { kind: 'none' },
			donate: { kind: 'hidden' }
		}
	});
}

beforeEach(async () => {
	FakeEventSource.opened = [];
	refreshAll.mockClear();
	vi.stubGlobal('EventSource', FakeEventSource);
	localStorage.clear();
	await page.viewport(1280, 800);
});

describe('Machines list (D6, D7)', () => {
	it('D6: search covers name, hostname, description and operating system', async () => {
		const screen = await renderPage();
		const search = screen.getByPlaceholder('Search name, host, description or system');
		const reception = screen.getByRole('heading', { name: 'Reception PC' });
		const build = screen.getByRole('heading', { name: 'Build server' });

		for (const [query, shows, hides] of [
			['reception', reception, build],
			['BUILD-01', build, reception],
			['label 14', reception, build],
			['windows', reception, build],
			['linux', build, reception]
		] as const) {
			await search.fill(query);
			await expect.element(shows, { message: query }).toBeVisible();
			await expect.element(hides, { message: query }).not.toBeInTheDocument();
		}
		await search.fill('nothing like this');
		await expect.element(screen.getByText('No machines match.')).toBeVisible();
	});

	it('D7: a card shows the last signed-in user, small, and nothing when none was seen', async () => {
		const screen = await renderPage();
		await expect.element(screen.getByText('Last user: sarah.k, 2 days ago')).toBeVisible();
		expect(screen.container.querySelectorAll('.last-user')).toHaveLength(1);
	});
});

describe('Machines views: cards and table', () => {
	const tableOf = (screen: Awaited<ReturnType<typeof renderPage>>) =>
		screen.getByRole('table', { name: 'Machines' });

	it('shows cards up to 50 machines and the table above, until someone picks', async () => {
		const few = await renderPage(fleet(50));
		await expect.element(few.getByRole('heading', { name: 'Machine 001' })).toBeVisible();
		await expect.element(tableOf(few)).not.toBeInTheDocument();
		await few.unmount();

		const many = await renderPage(fleet(51));
		await expect.element(tableOf(many)).toBeVisible();
	});

	it('remembers the pick in this browser', async () => {
		const first = await renderPage();
		await first.getByRole('button', { name: 'Table' }).click();
		await expect.element(tableOf(first)).toBeVisible();
		expect(localStorage.getItem('bmuster-machines-view')).toBe('table');
		await first.unmount();

		const again = await renderPage();
		await expect.element(tableOf(again)).toBeVisible();
		await expect
			.element(again.getByRole('button', { name: 'Table' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('uses the default, and still switches, when storage is blocked', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new DOMException('blocked', 'SecurityError');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('blocked', 'SecurityError');
		});
		const screen = await renderPage(fleet(60));
		await expect.element(tableOf(screen)).toBeVisible();
		await screen.getByRole('button', { name: 'Cards' }).click();
		await expect.element(screen.getByRole('heading', { name: 'Machine 001' })).toBeVisible();
	});

	it('SPEC-STORAGE S21: a nearly full drive is tagged on cards and rows, and filtered as Low disk', async () => {
		const full = machine({
			id: '33333333-3333-4333-8333-333333333333',
			name: 'File server',
			lowDisk: [{ mount: 'D:\\', percent: 94, freeBytes: 6 * 1024 ** 3 }]
		});
		const screen = await renderPage([...MACHINES, full]);
		const tag = screen.getByText('Low disk: D:\\ 94 %');
		await expect.element(tag).toBeVisible();
		await expect.element(tag).toHaveAttribute('title', 'D:\\ is 94 % full, 6.0 GB free');
		await screen.getByRole('button', { name: /^Low disk/ }).click();
		await expect.element(screen.getByText('Reception PC')).not.toBeInTheDocument();
		await expect.element(screen.getByText('File server')).toBeVisible();
		await screen.getByRole('button', { name: /^Needs attention/ }).click();
		await expect.element(screen.getByText('File server')).toBeVisible();
		await screen.getByRole('button', { name: 'Table' }).click();
		const table = screen.getByRole('table', { name: 'Machines' });
		await expect.element(table.getByText('Low disk: D:\\ 94 %').first()).toBeVisible();
	});

	it('the table shares the search and the filter chips', async () => {
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage(fleet(10));
		const table = tableOf(screen);
		await expect.element(table).toBeVisible();
		await screen.getByRole('button', { name: /^Offline/ }).click();
		expect(table.element().querySelectorAll('tbody tr')).toHaveLength(5);
		await screen.getByPlaceholder('Search name, host, description or system').fill('machine 002');
		await expect.poll(() => table.element().querySelectorAll('tbody tr').length).toBe(1);
		await expect.element(table.getByRole('link', { name: /Machine 002/ }).first()).toBeVisible();
	});

	it('keeps the Machines table focused on identity and status, without resource columns', async () => {
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage(fleet(3));
		const table = tableOf(screen);
		for (const heading of ['Name', 'Status', 'OS', 'Last user', 'Last seen', 'Open']) {
			await expect.element(table.getByRole('columnheader', { name: heading })).toBeVisible();
		}
		for (const heading of ['CPU', 'Memory', 'Disk']) {
			expect(
				[...table.element().querySelectorAll('th')].some(
					(cell) => cell.textContent.trim() === heading
				)
			).toBe(false);
		}
	});

	it('the table sorts by status and opens machines, with Terminal and Desktop per row', async () => {
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage(fleet(4));
		await screen.getByRole('button', { name: 'Status' }).click();
		const names = [...tableOf(screen).element().querySelectorAll('tbody tr .title')].map(
			(cell) => cell.textContent
		);
		expect(names).toEqual(['Machine 002', 'Machine 004', 'Machine 001', 'Machine 003']);
		await expect
			.element(screen.getByRole('link', { name: 'Terminal on Machine 001' }))
			.toHaveAttribute('href', `/machines/${fleet(1)[0]?.id ?? ''}/terminal`);
		await expect
			.element(screen.getByRole('link', { name: 'Desktop on Machine 001' }))
			.toBeVisible();
	});

	it('renders the first 60 cards and adds more on scroll, while counts cover every machine', async () => {
		const screen = await renderPage(fleet(130));
		await screen.getByRole('button', { name: 'Cards' }).click();
		const cards = () => screen.container.querySelectorAll('ul.grid > li').length;
		await expect.poll(cards).toBe(60);
		await expect.element(screen.getByText('65 of 130 online')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: /^Offline/ }))
			.toHaveTextContent('Offline 65');
		screen.getByTestId('scroll-batches-end').element().scrollIntoView();
		await expect.poll(cards).toBe(120);
		// Search still reaches machines that were never rendered.
		await screen.getByPlaceholder('Search name, host, description or system').fill('machine 130');
		await expect.element(screen.getByRole('heading', { name: 'Machine 130' })).toBeVisible();
	});

	it('on a phone the table is one line per machine', async () => {
		await page.viewport(390, 844);
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage(fleet(3));
		const list = screen.getByRole('list', { name: 'Machines' });
		await expect.element(list).toBeVisible();
		expect(screen.container.querySelector('table')?.checkVisibility()).toBe(false);
		await expect
			.element(list.getByRole('link', { name: /Machine 002/ }))
			.toHaveTextContent('Machine 002 machine-002 Offline');
	});

	it('SPEC-AGENT-UPDATES: an out-of-date agent is badged on its card and its table row', async () => {
		const machines = [
			machine({
				id: '33333333-3333-4333-8333-333333333333',
				name: 'Old agent',
				agentVersion: '0.1.0',
				update: { kind: 'available', version: '0.2.0', needsReinstall: true }
			}),
			machine({
				id: '44444444-4444-4444-8444-444444444444',
				name: 'Fussy',
				update: { kind: 'pinned', available: { kind: 'none' } }
			}),
			machine({
				id: '55555555-5555-4555-8555-555555555555',
				name: 'Broken update',
				update: { kind: 'rolled-back', version: '0.3.0', reason: 'no check-in' }
			}),
			machine({ id: '66666666-6666-4666-8666-666666666666', name: 'Current' })
		];
		const screen = await renderPage(machines);
		await screen.getByRole('button', { name: 'Cards' }).click();
		await expect.element(screen.getByText('Update available')).toBeVisible();
		await expect.element(screen.getByText('Pinned')).toBeVisible();
		await expect.element(screen.getByText('Rolled back')).toBeVisible();
		expect(screen.container.querySelectorAll('[data-update-state]')).toHaveLength(3);

		await screen.getByRole('button', { name: 'Table' }).click();
		const row = screen.getByRole('row').filter({ hasText: 'Old agent' });
		await expect.element(row.getByText('Update available')).toBeVisible();
		const current = screen.getByRole('row').filter({ hasText: 'Current' });
		expect(current.getByText(/Update|Pinned|Rolled back/).all()).toHaveLength(0);
	});

	it('SPEC-AGENT-UPDATES: tells an admin when a failed update paused the roll-out', async () => {
		const screen = await renderPage(MACHINES, {
			kind: 'rollout',
			version: '0.3.0',
			stage: 'early',
			startedIso: '2026-11-07T11:00:00.000Z',
			stageStartedIso: '2026-11-07T11:00:00.000Z',
			paused: {
				kind: 'paused',
				reason: 'Build server rolled back 0.3.0: no check-in',
				atIso: '2026-11-07T11:30:00.000Z',
				by: 'system'
			}
		});
		const notice = screen.getByRole('alert');
		await expect
			.element(notice.getByText('Agent updates are paused: version 0.3.0 failed'))
			.toBeVisible();
		await expect.element(notice.getByRole('link', { name: 'Open Updates' })).toBeVisible();
	});
});

describe('Machines export (SPEC-CSV-EXPORT X1, X6)', () => {
	/** The links the Export button downloads, caught before the browser follows them. */
	function catchDownloads(): string[] {
		const links: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement
		) {
			links.push(this.getAttribute('href') ?? '');
		});
		return links;
	}

	it('X1: sits next to the Cards / Table switch in the header', async () => {
		const screen = await renderPage();
		const header = screen.container.querySelector('header .actions');
		expect(
			[...(header?.querySelectorAll('button') ?? [])].map((button) => button.textContent.trim())
		).toEqual(['Cards', 'Table', 'Export']);
	});

	it('X6: Cards view exports the search and filter, in list order', async () => {
		const links = catchDownloads();
		const screen = await renderPage(fleet(130));
		await screen.getByRole('button', { name: 'Cards' }).click();
		await screen.getByRole('button', { name: 'Export' }).click();
		await screen.getByRole('button', { name: /^Offline/ }).click();
		await screen.getByPlaceholder('Search name, host, description or system').fill(' machine 1 ');
		await screen.getByRole('button', { name: 'Export' }).click();
		expect(links).toEqual([
			'/api/exports/machines',
			'/api/exports/machines?search=machine+1&filter=offline'
		]);
	});

	it("X6: Table view adds the table's sort, following the heading clicked", async () => {
		const links = catchDownloads();
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage(fleet(4));
		await screen.getByRole('button', { name: 'Export' }).click();
		await screen.getByRole('button', { name: 'Status' }).click();
		await screen.getByRole('button', { name: 'Status' }).click();
		await screen.getByRole('button', { name: 'Export' }).click();
		expect(links).toEqual([
			'/api/exports/machines?sort=name&direction=asc',
			'/api/exports/machines?sort=status&direction=desc'
		]);
	});

	it('X1: the header wraps on a phone with Export still on screen', async () => {
		await page.viewport(390, 844);
		const screen = await renderPage();
		const exportButton = screen.getByRole('button', { name: 'Export' });
		await expect.element(exportButton).toBeVisible();
		const box = exportButton.element().getBoundingClientRect();
		expect(box.right).toBeLessThanOrEqual(390);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});

describe('Machines list, live (SPEC-PRESENCE P5)', () => {
	const RECEPTION = MACHINES[0]?.id ?? '';
	const offline = (atMs: number): MachineStatusEvent => ({
		machineId: RECEPTION,
		status: { kind: 'offline', sinceIso: new Date(atMs).toISOString() },
		atIso: new Date(atMs).toISOString()
	});

	it('listens to the live feed and updates a card when a machine goes offline and back', async () => {
		const screen = await renderPage();
		expect(feed().url).toBe('/api/machines/events');
		const card = screen.getByRole('listitem').filter({ hasText: 'Reception PC' });
		await expect.element(card.getByText('Online')).toBeVisible();
		await expect.element(screen.getByText('2 of 2 online')).toBeVisible();

		feed().push(offline(NOW + 60_000));
		await expect.element(card.getByText('Offline · just now')).toBeVisible();
		await expect.element(screen.getByText('1 of 2 online')).toBeVisible();

		feed().push({
			machineId: RECEPTION,
			status: { kind: 'online' },
			atIso: new Date(NOW + 90_000).toISOString()
		});
		await expect.element(card.getByText('Online')).toBeVisible();
		expect(refreshAll).not.toHaveBeenCalled();
	});

	it('updates a table row too, and ignores a status older than the loaded page', async () => {
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage();
		const row = screen.getByRole('row').filter({ hasText: 'Reception PC' });
		feed().push(offline(NOW - 60_000));
		await expect.element(screen.getByText('2 of 2 online')).toBeVisible();
		feed().push(offline(NOW + 120_000));
		await expect.element(row.getByText('Offline')).toBeVisible();
		await expect.element(screen.getByText('1 of 2 online')).toBeVisible();
	});

	it('keeps the cards drawn and the scroll position when an update arrives', async () => {
		const machines = fleet(130);
		const screen = await renderPage(machines);
		await screen.getByRole('button', { name: 'Cards' }).click();
		const cards = () => screen.container.querySelectorAll('ul.grid > li').length;
		screen.getByTestId('scroll-batches-end').element().scrollIntoView();
		await expect.poll(cards).toBe(120);
		const scrolled = window.scrollY;
		expect(scrolled).toBeGreaterThan(0);

		feed().push({
			machineId: machines[0]?.id ?? '',
			status: { kind: 'offline', sinceIso: new Date(NOW).toISOString() },
			atIso: new Date(NOW + 1000).toISOString()
		});
		await expect.element(screen.getByText('64 of 130 online')).toBeVisible();
		expect(cards()).toBe(120);
		expect(window.scrollY).toBe(scrolled);
	});

	it('falls back to reloading every 15 seconds when the feed is refused', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			await renderPage();
			feed().refuse();
			vi.advanceTimersByTime(15_000);
			expect(refreshAll).toHaveBeenCalledOnce();
			vi.advanceTimersByTime(15_000);
			expect(refreshAll).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('T9: on a phone the Table view puts "In use" under the name, inside the screen', async () => {
		await page.viewport(390, 844);
		localStorage.setItem('bmuster-machines-view', 'table');
		const screen = await renderPage([
			machine({
				id: '33333333-3333-4333-8333-333333333333',
				name: 'AUADRNBK00007',
				osFamily: 'windows',
				inUse: [
					{ kind: 'files', userName: 'Jack Brumley' },
					{ kind: 'terminal', userName: 'Jack Brumley' }
				]
			})
		]);
		const visible = (elements: Element[]) =>
			elements.map((element) => element.getBoundingClientRect()).find((box) => box.width > 0);
		const status = visible(screen.getByText('Online', { exact: true }).elements());
		const line = visible(screen.getByText(/^In use: files by Jack Brumley/).elements());
		if (status === undefined || line === undefined) throw new Error('Badge or line not shown');
		expect(line.right).toBeLessThanOrEqual(status.left);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
