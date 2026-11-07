import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import LocalPage from './local-page.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

const REPORTED = {
	kind: 'reported',
	address: 'https://localhost:47500',
	fingerprint: FINGERPRINT,
	reportedIso: '2026-11-07T12:00:00.000Z'
} as const;

function replyWith(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

describe('Manage tab: Local page (SPEC-AGENT-LOCAL)', () => {
	it('tells an admin plainly to update an older agent', async () => {
		const screen = await render(LocalPage, { machineId: MACHINE_ID, localPage: { kind: 'none' } });
		await expect.element(screen.getByText(/Update the agent to get a local page/)).toBeVisible();
		expect(screen.getByRole('button', { name: /Show local page code/ }).all()).toHaveLength(0);
	});

	it('shows the address, the fingerprint, and the code with its countdown on request', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(replyWith({ kind: 'code', code: '123456', secondsLeft: 2, scope: 'person' }))
		);
		vi.stubGlobal('fetch', fetch);
		const screen = await render(LocalPage, { machineId: MACHINE_ID, localPage: REPORTED });
		await expect.element(screen.getByText('https://localhost:47500')).toBeVisible();
		await expect.element(screen.getByText(FINGERPRINT)).toBeVisible();
		expect(fetch).not.toHaveBeenCalled();

		await screen.getByRole('button', { name: /Show local page code/ }).click();
		await expect.element(screen.getByText('123 456')).toBeVisible();
		await expect.element(screen.getByText(/Changes in 2 s/)).toBeVisible();
		// P2: the viewer's own code.
		await expect.element(screen.getByText(/Your own code/)).toBeVisible();
		expect(fetch).toHaveBeenCalledWith(
			`/api/machines/${MACHINE_ID}/local-code`,
			expect.objectContaining({ method: 'POST' })
		);

		// When the code rolls over, the next one is fetched.
		fetch.mockImplementation(() =>
			Promise.resolve(replyWith({ kind: 'code', code: '654321', secondsLeft: 30, scope: 'person' }))
		);
		await expect.element(screen.getByText('654 321')).toBeVisible();
		expect(fetch).toHaveBeenCalledTimes(2);

		await screen.getByRole('button', { name: /Hide code/ }).click();
		await expect.element(screen.getByText('654 321')).not.toBeInTheDocument();
	});

	it('P3: says an older agent still takes the shared code and needs an update', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof globalThis.fetch>(() =>
				Promise.resolve(
					replyWith({ kind: 'code', code: '111222', secondsLeft: 20, scope: 'machine' })
				)
			)
		);
		const screen = await render(LocalPage, { machineId: MACHINE_ID, localPage: REPORTED });
		await screen.getByRole('button', { name: /Show local page code/ }).click();
		await expect.element(screen.getByText('111 222')).toBeVisible();
		await expect
			.element(screen.getByText(/A shared code: every admin sees this one/))
			.toBeVisible();
		await expect.element(screen.getByText(/give each person their own code/)).toBeVisible();
	});
});
