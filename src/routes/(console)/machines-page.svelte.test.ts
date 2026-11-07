import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Machine } from '#lib/domain/machines/machine.ts';
import MachinesPage from './+page.svelte';
import type { PageData } from './$types';

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
					: { kind: 'offline', lastSeenIso: '2026-11-06T12:00:00.000Z' }
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
			now: NOW,
			rollout,
			view: { kind: 'machines', machines }
		}
	});
}

beforeEach(async () => {
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
