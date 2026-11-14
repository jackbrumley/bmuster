import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { resolve } from '$app/paths';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { fakeAppPage } from '#tests/helpers/fake-app-page.svelte.ts';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import MachineOverviewFrame from '#tests/helpers/machine-overview-frame.svelte';

vi.mock('$app/state', async () => ({
	page: (await import('#tests/helpers/fake-app-page.svelte.ts')).fakeAppPage
}));
vi.mock('$app/navigation', () => ({ refreshAll: vi.fn(() => Promise.resolve()) }));

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const OVERVIEW = resolve('/(console)/machines/[id]', { id: TEST_MACHINE.id });

/** An online machine with enough adapters that Overview is several phone screens tall. */
function machineAt(cpuPercent: number): Machine {
	return {
		...TEST_MACHINE,
		live: {
			kind: 'known',
			cpuPercent,
			memoryUsedBytes: 4 * 1024 ** 3,
			uptimeSeconds: 3600,
			signedInUser: { kind: 'none' }
		},
		inventory: {
			kind: 'known',
			osName: 'Ubuntu',
			osVersion: '24.04',
			osBuild: '6.8.0',
			updates: { kind: 'known', count: 0 },
			cpuModel: 'Test CPU',
			cpuCores: 8,
			memoryTotalBytes: 16 * 1024 ** 3,
			disks: [{ mount: '/', sizeBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3 }],
			network: Array.from({ length: 12 }, (_, index) => ({
				name: `eth${index}`,
				mac: '00:11:22:33:44:55',
				addresses: [`10.0.0.${index + 1}`]
			})),
			gpus: [],
			display: { kind: 'unreported' },
			power: { kind: 'unreported' }
		}
	};
}

function dataFor(machine: Machine) {
	return {
		user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
		localNetworkMode: false,
		serverUpdate: null,
		runCommands: false,
		assistant: { kind: 'none' as const },
		signedIn: true as const,
		now: NOW,
		machine,
		grants: [{ permission: 'view' as const, consent: 'unattended' as const }]
	};
}

/** Two frames: long enough for any effect, scroll and resize observer to run. */
async function settle(): Promise<void> {
	await tick();
	for (let frame = 0; frame < 2; frame += 1) {
		await new Promise((done) => requestAnimationFrame(done));
	}
}

/** Overview at phone size, scrolled well down the page. */
async function scrolledOverview() {
	await page.viewport(390, 700);
	fakeAppPage.url = new URL(`https://bmuster.test${OVERVIEW}`);
	const screen = await render(MachineOverviewFrame, { data: dataFor(machineAt(5)) });
	await expect.element(screen.getByRole('heading', { name: 'Network' })).toBeVisible();
	// Half-way down, not the bottom: a shorter page may pull the bottom up.
	window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) / 2);
	await settle();
	const scrolledTo = window.scrollY;
	expect(scrolledTo).toBeGreaterThan(400);
	return { screen, scrolledTo };
}

beforeEach(() => {
	FakeEventSource.opened = [];
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	window.scrollTo(0, 0);
});

describe('Overview keeps its place while it updates (SPEC-MACHINE-DETAILS D15)', () => {
	it('D15: a live figure refresh leaves the page where it was scrolled to', async () => {
		const { screen, scrolledTo } = await scrolledOverview();
		// What SvelteKit does on each 3-second refresh: new data and a new
		// `page.url` object for the same address.
		for (const cpu of [40, 75, 12]) {
			fakeAppPage.url = new URL(`https://bmuster.test${OVERVIEW}`);
			await screen.rerender({ data: dataFor(machineAt(cpu)) });
			await settle();
			await expect.element(screen.getByText(`${cpu}%`)).toBeInTheDocument();
			expect(window.scrollY).toBe(scrolledTo);
		}
	});

	it('D15: status events, the network returning and the phone resizing leave the page where it was', async () => {
		const { scrolledTo } = await scrolledOverview();
		// Going offline drops the live figures above the reader, so the page
		// moves by those few lines at most; it never jumps back to the top.
		feed().push({
			machineId: TEST_MACHINE.id,
			status: { kind: 'reconnecting', sinceIso: new Date(NOW + 1000).toISOString() },
			atIso: new Date(NOW + 1000).toISOString()
		});
		await settle();
		await expect
			.element(page.getByText('Live figures show when the machine is online.'))
			.toBeInTheDocument();
		expect(Math.abs(window.scrollY - scrolledTo)).toBeLessThan(80);
		feed().push({
			machineId: TEST_MACHINE.id,
			status: { kind: 'online' },
			atIso: new Date(NOW + 2000).toISOString()
		});
		window.dispatchEvent(new Event('online'));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(Math.abs(window.scrollY - scrolledTo)).toBeLessThan(80);
		// The address bar hiding as the page scrolls makes the window taller.
		await page.viewport(390, 760);
		await settle();
		expect(Math.abs(window.scrollY - scrolledTo)).toBeLessThan(80);
	});
});
