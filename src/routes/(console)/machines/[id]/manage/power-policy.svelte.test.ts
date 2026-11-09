import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PowerReport } from '#lib/domain/machines/power.ts';
import PowerPolicy from './power-policy.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

function reported(
	keepAwake: 'off' | 'active' | 'waiting-for-mains',
	source: 'mains' | 'battery' | 'unknown',
	inhibitor: Extract<PowerReport, { kind: 'reported' }>['inhibitor']
): PowerReport {
	return { kind: 'reported', source, batteryPercent: 80, keepAwake, inhibitor };
}

function props(keepAwakeOnAc: boolean, power: PowerReport | { kind: 'pending' }) {
	return { machineId: MACHINE_ID, machineName: 'laptop', keepAwakeOnAc, power };
}

describe('Manage tab: Power card (SPEC-STAY-AWAKE P7)', () => {
	it("P7: shows the switch and the report's power line", async () => {
		const active = await render(
			PowerPolicy,
			props(true, reported('active', 'mains', { kind: 'held' }))
		);
		await expect
			.element(active.getByRole('group', { name: 'Stay awake on mains power' }))
			.toBeVisible();
		await expect
			.element(active.getByRole('button', { name: 'On' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(active.getByText('On mains power (battery 80%): staying awake'))
			.toBeVisible();
		await active.unmount();

		const battery = await render(
			PowerPolicy,
			props(true, reported('waiting-for-mains', 'battery', { kind: 'none' }))
		);
		await expect
			.element(battery.getByText('On battery (80%): sleeping normally until mains returns'))
			.toBeVisible();
		await battery.unmount();

		const failed = await render(
			PowerPolicy,
			props(true, reported('active', 'mains', { kind: 'failed', reason: 'Access denied' }))
		);
		await expect
			.element(failed.getByText(/could not keep the machine awake: Access denied/))
			.toBeVisible();
		await failed.unmount();

		const old = await render(PowerPolicy, props(false, { kind: 'unreported' }));
		await expect.element(old.getByText(/too old to report its power source/)).toBeVisible();
	});

	it('P7: turning it on sends only the boolean, then refreshes the page', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ keepAwakeOnAc: true, delivered: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		vi.stubGlobal('fetch', fetch);
		const screen = await render(
			PowerPolicy,
			props(false, reported('off', 'mains', { kind: 'none' }))
		);
		await expect
			.element(screen.getByText('On mains power (battery 80%): sleeps as the machine is set to'))
			.toBeVisible();
		await screen.getByRole('button', { name: 'On' }).click();
		await expect.poll(() => refreshAll.mock.calls.length).toBe(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(`/api/machines/${MACHINE_ID}/power-policy`);
		expect(init?.method).toBe('PUT');
		expect(init?.body).toBe('{"keepAwakeOnAc":true}');
		// Choosing what the server already holds (off, until the page refreshes) sends nothing.
		await screen.getByRole('button', { name: 'Off' }).click();
		expect(fetch.mock.calls).toHaveLength(1);
	});

	it('P7: at phone width a long failure wraps and nothing overflows', async () => {
		await page.viewport(390, 844);
		const screen = await render(
			PowerPolicy,
			props(
				true,
				reported('active', 'mains', {
					kind: 'failed',
					reason: `org.freedesktop.DBus.Error.AccessDenied:${'x'.repeat(300)}`
				})
			)
		);
		await expect.element(screen.getByText(/could not keep the machine awake/)).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
