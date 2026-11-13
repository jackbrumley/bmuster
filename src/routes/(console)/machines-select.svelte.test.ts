import '../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { CommandSelection } from '#lib/domain/commands/commands.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import { FakeEventSource } from '#tests/helpers/fake-event-source.ts';
import MachinesPage from './+page.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const goto = vi.hoisted(() => vi.fn((_url: string, _options: unknown) => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll, goto }));

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function machine(id: number, name: string, overrides: Partial<Machine> = {}): Machine {
	return {
		...TEST_MACHINE,
		id: `00000000-0000-4000-8000-00000000000${id}`,
		name,
		hostname: name.toLowerCase().replaceAll(' ', '-'),
		...overrides
	};
}

const LAPTOP_1 = machine(1, 'Laptop 1', { osFamily: 'windows' });
const LAPTOP_2 = machine(2, 'Laptop 2', { osFamily: 'windows' });
const LAPTOP_3 = machine(3, 'Laptop 3', {
	osFamily: 'windows',
	status: { kind: 'offline', sinceIso: '2026-11-13T12:00:00.000Z' }
});
const WEB_1 = machine(4, 'Web 1', { osFamily: 'linux' });
const PAYROLL = machine(5, 'Payroll', { osFamily: 'windows' });
const MACHINES = [LAPTOP_1, LAPTOP_2, LAPTOP_3, WEB_1, PAYROLL];

const ALLOWED: CommandSelection = {
	kind: 'allowed',
	// Payroll: seen, but no run-commands there (C5).
	runnable: [LAPTOP_1.id, LAPTOP_2.id, LAPTOP_3.id, WEB_1.id],
	groups: [
		{ id: 'g-all', name: 'All machines', machineIds: MACHINES.map((entry) => entry.id) },
		{
			id: 'g-laptops',
			name: 'Corporate Laptops',
			machineIds: [LAPTOP_1.id, LAPTOP_2.id, LAPTOP_3.id, PAYROLL.id]
		},
		{ id: 'g-web', name: 'Linux Web Servers', machineIds: [WEB_1.id] }
	]
};

function renderPage(commands: CommandSelection = ALLOWED) {
	return render(MachinesPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'member' },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: commands.kind === 'allowed',
			signedIn: true,
			now: NOW,
			rollout: { kind: 'none' },
			view: { kind: 'machines', machines: MACHINES },
			commands
		}
	});
}

beforeEach(async () => {
	FakeEventSource.opened = [];
	goto.mockClear();
	vi.stubGlobal('EventSource', FakeEventSource);
	localStorage.clear();
	await page.viewport(1280, 800);
});

function tickBoxes(container: HTMLElement): HTMLInputElement[] {
	return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
		(box) => box.offsetParent !== null
	);
}

describe('select mode (SPEC-COMMANDS C1–C5)', () => {
	it('C1: Select is offered only to people who may run commands; Done leaves and clears', async () => {
		const without = await renderPage({ kind: 'none' });
		await expect.element(without.getByRole('heading', { name: 'Laptop 1' })).toBeVisible();
		expect(without.getByRole('button', { name: 'Select' }).query()).toBeNull();
		await without.unmount();

		const screen = await renderPage();
		expect(tickBoxes(screen.container)).toHaveLength(0);
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		const box = screen.getByRole('checkbox', { name: 'Select Laptop 1' });
		await expect.element(box).toBeVisible();
		// The tick box's whole label is the 40 px touch target.
		const target = box.element().closest('label');
		expect(target?.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
		expect(target?.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
		await box.click();
		await expect.element(screen.getByText('1 selected')).toBeVisible();
		await screen.getByRole('button', { name: 'Done' }).click();
		expect(tickBoxes(screen.container)).toHaveLength(0);
		await expect.element(screen.getByText('1 selected')).not.toBeInTheDocument();
		// Back in select mode, nothing is still ticked.
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		await expect
			.element(screen.getByRole('checkbox', { name: 'Select Laptop 1' }))
			.not.toBeChecked();

		// The table has tick boxes too.
		await screen.getByRole('button', { name: 'Table' }).click();
		await expect.element(screen.getByRole('checkbox', { name: 'Select Web 1' })).toBeVisible();
	});

	it('C2: group chips (All machines first), then Windows, Linux and Online, narrow the list', async () => {
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		const chips = screen.getByRole('group', { name: 'Narrow the machines' });
		await expect.element(chips).toBeVisible();
		const labels = [...chips.element().querySelectorAll('button')].map((chip) =>
			chip.textContent.trim()
		);
		expect(labels).toEqual([
			'All machines',
			'Corporate Laptops',
			'Linux Web Servers',
			'Windows',
			'Linux',
			'Online'
		]);
		const shown = () =>
			[...screen.container.querySelectorAll('h2')].map((heading) => heading.textContent.trim());

		await chips.getByRole('button', { name: 'Corporate Laptops' }).click();
		expect(shown()).toEqual(['Laptop 1', 'Laptop 2', 'Laptop 3', 'Payroll']);
		// Groups combine as "in any of these groups".
		await chips.getByRole('button', { name: 'Linux Web Servers' }).click();
		expect(shown()).toEqual(['Laptop 1', 'Laptop 2', 'Laptop 3', 'Web 1', 'Payroll']);
		// The system and Online chips narrow further.
		await chips.getByRole('button', { name: 'Windows' }).click();
		expect(shown()).toEqual(['Laptop 1', 'Laptop 2', 'Laptop 3', 'Payroll']);
		await chips.getByRole('button', { name: 'Online' }).click();
		expect(shown()).toEqual(['Laptop 1', 'Laptop 2', 'Payroll']);
		await expect
			.element(chips.getByRole('button', { name: 'Online' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('C3: Select all ticks exactly the machines shown; earlier ticks stay and count', async () => {
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		expect(screen.getByRole('button', { name: /^Select all/ }).query()).toBeNull();
		await screen.getByRole('checkbox', { name: 'Select Web 1' }).click();
		const chips = screen.getByRole('group', { name: 'Narrow the machines' });
		await chips.getByRole('button', { name: 'Corporate Laptops' }).click();
		await chips.getByRole('button', { name: 'Online' }).click();
		await screen.getByRole('button', { name: /^Select all 2/ }).click();
		await expect.element(screen.getByRole('checkbox', { name: 'Select Laptop 1' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'Select Laptop 2' })).toBeChecked();
		// Web 1 is hidden by the filter but still ticked, and counted.
		await expect.element(screen.getByText('3 selected')).toBeVisible();
		await chips.getByRole('button', { name: 'Online' }).click();
		await expect
			.element(screen.getByRole('checkbox', { name: 'Select Laptop 3' }))
			.not.toBeChecked();
	});

	it('C4: the bottom bar shows the count, Clear and Run command, fixed to the bottom', async () => {
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		await screen.getByRole('checkbox', { name: 'Select Laptop 1' }).click();
		await screen.getByRole('checkbox', { name: 'Select Web 1' }).click();
		const bar = screen.getByRole('region', { name: 'Selected machines' });
		await expect.element(bar.getByText('2 selected')).toBeVisible();
		expect(getComputedStyle(bar.element()).position).toBe('fixed');
		await bar.getByRole('button', { name: 'Run command' }).click();
		expect(goto).toHaveBeenCalledWith('/commands/new', {
			state: {
				commandDraft: {
					machineIds: [LAPTOP_1.id, WEB_1.id],
					scripts: [],
					timeoutMs: 60_000,
					rerunOf: null
				}
			}
		});
		await bar.getByRole('button', { name: 'Clear' }).click();
		await expect.element(bar).not.toBeInTheDocument();
		// Also on a phone.
		await page.viewport(360, 780);
		await screen.getByRole('checkbox', { name: 'Select Laptop 2' }).click();
		const phoneBar = screen.getByRole('region', { name: 'Selected machines' });
		const rect = phoneBar.element().getBoundingClientRect();
		expect(rect.bottom).toBeLessThanOrEqual(780);
		expect(rect.right).toBeLessThanOrEqual(360);
	});

	it('C5: a machine the person cannot run commands on has no tick box, and Select all says so', async () => {
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Select', exact: true }).click();
		await expect.element(screen.getByRole('checkbox', { name: 'Select Laptop 1' })).toBeVisible();
		expect(screen.getByRole('checkbox', { name: 'Select Payroll' }).query()).toBeNull();
		const chips = screen.getByRole('group', { name: 'Narrow the machines' });
		await chips.getByRole('button', { name: 'Corporate Laptops' }).click();
		const all = screen.getByRole('button', { name: /^Select all/ });
		await expect.element(all).toHaveTextContent('Select all 3 · 1 you cannot run commands on');
		await all.click();
		await expect.element(screen.getByText('3 selected')).toBeVisible();
	});
});
