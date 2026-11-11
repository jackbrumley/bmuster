import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Machine, MachineInventory } from '#lib/domain/machines/machine.ts';
import Overview from './+page.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

const INVENTORY: MachineInventory = {
	kind: 'known',
	osName: 'Ubuntu',
	osVersion: '24.04',
	osBuild: '6.8.0',
	updates: { kind: 'known', count: 0 },
	cpuModel: 'Test CPU',
	cpuCores: 8,
	memoryTotalBytes: 16 * 1024 ** 3,
	disks: [],
	network: [
		{ name: 'eth0', mac: '00:11:22:33:44:55', addresses: ['10.0.0.5', 'fe80::1'] },
		{ name: 'tun0', mac: '00:00:00:00:00:00', addresses: ['10.8.0.2'] },
		{ name: 'wlan0', mac: '66:77:88:99:aa:bb', addresses: ['192.168.1.20'] }
	],
	gpus: [
		{
			name: 'NVIDIA GeForce RTX 4070',
			vendor: 'NVIDIA Corporation',
			memoryBytes: { kind: 'known', bytes: 12 * 1024 ** 3 },
			driver: 'nvidia 550.54'
		},
		{
			name: 'NVIDIA GeForce RTX 4070',
			vendor: 'NVIDIA Corporation',
			memoryBytes: { kind: 'known', bytes: 12 * 1024 ** 3 },
			driver: 'nvidia 550.54'
		},
		{
			name: 'Intel UHD Graphics 770',
			vendor: 'Intel',
			memoryBytes: { kind: 'unknown' },
			driver: ''
		}
	],
	display: { kind: 'unreported' },
	power: {
		kind: 'reported',
		source: 'battery',
		batteryPercent: 45,
		keepAwake: 'off',
		inhibitor: { kind: 'none' }
	}
};

const MACHINE: Machine = {
	id: MACHINE_ID,
	name: 'Reception PC',
	description: '',
	hostname: 'reception',
	osFamily: 'linux',
	target: 'x86_64-unknown-linux-gnu',
	agentVersion: '0.4.14',
	update: { kind: 'up-to-date' },
	status: { kind: 'online' },
	lastUser: { kind: 'none' },
	live: {
		kind: 'known',
		cpuPercent: 5,
		memoryUsedBytes: 1024 ** 3,
		uptimeSeconds: 3 * 86_400 + 4 * 3600 + 5 * 60,
		signedInUser: { kind: 'none' }
	},
	inventory: INVENTORY,
	enrolledIso: '2026-11-01T00:00:00.000Z',
	lastSeenIso: '2026-11-11T12:00:00.000Z',
	inUse: []
};

function renderOverview(machine: Machine) {
	return render(Overview, {
		params: { id: MACHINE_ID },
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			serverUpdate: null,
			signedIn: true,
			now: NOW,
			machine,
			grants: [{ permission: 'view', consent: 'unattended' }]
		}
	});
}

function factOf(container: HTMLElement, label: string): string | undefined {
	const term = [...container.querySelectorAll('dt')].find((dt) => dt.textContent === label);
	return term?.nextElementSibling?.textContent ?? undefined;
}

function rowsOf(screen: Awaited<ReturnType<typeof renderOverview>>, list: string): string[] {
	return screen
		.getByRole('list', { name: list })
		.getByRole('listitem')
		.all()
		.map((item) => item.element().textContent.replace(/\s+/g, ' ').trim());
}

describe('Overview: inventory (SPEC-MACHINE-DETAILS D10–D14)', () => {
	it('D10: lists every network adapter with its MAC address and addresses', async () => {
		const screen = await renderOverview(MACHINE);
		await expect.element(screen.getByRole('heading', { name: 'Network' })).toBeVisible();
		expect(rowsOf(screen, 'Network adapters')).toEqual([
			'eth0 MAC 00:11:22:33:44:55 · 10.0.0.5, fe80::1',
			'tun0 10.8.0.2',
			'wlan0 MAC 66:77:88:99:aa:bb · 192.168.1.20'
		]);
		// The flat Addresses fact gave way to the card.
		expect(factOf(screen.container, 'Addresses')).toBeUndefined();
	});

	it('D11: lists every graphics card with its vendor and driver, twins included', async () => {
		const screen = await renderOverview(MACHINE);
		await expect.element(screen.getByRole('heading', { name: 'Graphics' })).toBeVisible();
		expect(rowsOf(screen, 'Graphics cards')).toEqual([
			'NVIDIA GeForce RTX 4070 (12 GB) NVIDIA Corporation · driver nvidia 550.54',
			'NVIDIA GeForce RTX 4070 (12 GB) NVIDIA Corporation · driver nvidia 550.54',
			'Intel UHD Graphics 770 Intel · driver not reported'
		]);
		expect(factOf(screen.container, 'Graphics')).toBeUndefined();
	});

	it('D12, D13: shows uptime while online and the power source with the system facts', async () => {
		const online = await renderOverview(MACHINE);
		expect(factOf(online.container, 'Uptime')).toBe('3 days 4 h');
		expect(factOf(online.container, 'Power')).toBe('Battery, 45%');
		await online.unmount();
		const offline = await renderOverview({
			...MACHINE,
			status: { kind: 'offline', sinceIso: '2026-11-11T11:00:00.000Z' }
		});
		// Uptime is a live figure: stale once the machine is offline.
		expect(factOf(offline.container, 'Uptime')).toBeUndefined();
		expect(factOf(offline.container, 'Power')).toBe('Battery, 45%');
	});

	it('D10, D11: an inventory with no adapters or cards says none were reported', async () => {
		const screen = await renderOverview({
			...MACHINE,
			inventory: { ...INVENTORY, network: [], gpus: [] }
		});
		await expect.element(screen.getByText('No network adapters reported.')).toBeVisible();
		await expect.element(screen.getByText('No graphics cards reported.')).toBeVisible();
	});

	it('D14: a machine with no inventory yet waits for it in both cards and shows no power', async () => {
		const screen = await renderOverview({
			...MACHINE,
			live: { kind: 'none' },
			inventory: { kind: 'pending' }
		});
		await expect.element(screen.getByRole('heading', { name: 'Network' })).toBeVisible();
		await expect.element(screen.getByRole('heading', { name: 'Graphics' })).toBeVisible();
		// Disks, Network, Graphics and Display all wait for the first inventory.
		expect(screen.getByText('Waiting for the first inventory.').all()).toHaveLength(4);
		expect(factOf(screen.container, 'Power')).toBeUndefined();
		expect(factOf(screen.container, 'Uptime')).toBeUndefined();
	});
});
