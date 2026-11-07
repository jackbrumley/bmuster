import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Machine } from '#lib/domain/machines/machine.ts';
import MachinesPage from './+page.svelte';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

function machine(overrides: Partial<Machine> & Pick<Machine, 'id' | 'name'>): Machine {
	return {
		description: '',
		hostname: overrides.name.toLowerCase().replaceAll(' ', '-'),
		osFamily: 'linux',
		target: 'x86_64-unknown-linux-gnu',
		agentVersion: '0.2.0',
		status: { kind: 'online' },
		lastUser: { kind: 'none' },
		live: { kind: 'none' },
		inventory: { kind: 'pending' },
		enrolledIso: '2026-11-01T00:00:00.000Z',
		lastSeenIso: '2026-11-07T12:00:00.000Z',
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

function renderPage() {
	return render(MachinesPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			now: NOW,
			view: { kind: 'machines', machines: MACHINES }
		}
	});
}

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
