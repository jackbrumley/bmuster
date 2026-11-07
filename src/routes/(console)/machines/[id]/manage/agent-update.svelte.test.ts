import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AgentUpdate from './agent-update.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

describe('Manage tab: Agent panel updates (SPEC-AGENT-UPDATES)', () => {
	it('warns that an agent from before the launcher cannot update itself, and offers no Update now', async () => {
		const screen = await render(AgentUpdate, {
			machineId: MACHINE_ID,
			version: '0.1.0',
			update: { kind: 'available', version: '0.2.0', needsReinstall: true }
		});
		const warning = screen.getByRole('alert');
		await expect.element(warning.getByText('This agent cannot update itself')).toBeVisible();
		await expect
			.element(warning.getByText(/Reinstall\s+it\s+once\s+with\s+Reinstall\s+agent\s+below/))
			.toBeVisible();
		await expect.element(screen.getByText('Update available')).toBeVisible();
		expect(screen.getByRole('button', { name: /Update now/ }).all()).toHaveLength(0);
	});

	it('shows a rollback with its reason and lets an admin try again', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ requested: 1, skipped: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		vi.stubGlobal('fetch', fetch);
		const screen = await render(AgentUpdate, {
			machineId: MACHINE_ID,
			version: '0.1.0',
			update: {
				kind: 'rolled-back',
				version: '0.2.0',
				reason: 'version 0.2.0 stopped before it checked in'
			}
		});
		await expect.element(screen.getByRole('alert').getByText('Update rolled back')).toBeVisible();
		await expect.element(screen.getByText(/stopped before it checked in/)).toBeVisible();
		await screen.getByRole('button', { name: /Update now/ }).click();
		await vi.waitFor(() => {
			expect(fetch).toHaveBeenCalled();
		});
		expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent-updates/update-now');
	});

	it('pins and unpins', async () => {
		const pinned = await render(AgentUpdate, {
			machineId: MACHINE_ID,
			version: '0.1.0',
			update: { kind: 'pinned', available: { kind: 'version', version: '0.2.0' } }
		});
		await expect.element(pinned.getByText('Pinned', { exact: true })).toBeVisible();
		await expect.element(pinned.getByRole('button', { name: 'Unpin' })).toBeVisible();
		await pinned.unmount();
		const current = await render(AgentUpdate, {
			machineId: MACHINE_ID,
			version: '0.2.0',
			update: { kind: 'up-to-date' }
		});
		await expect.element(current.getByText('Up to date.')).toBeVisible();
		await expect
			.element(current.getByRole('button', { name: 'Pin to this version' }))
			.toBeVisible();
	});
});
