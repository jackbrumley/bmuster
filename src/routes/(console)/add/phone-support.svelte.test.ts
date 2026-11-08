import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PhoneSupport from './phone-support.svelte';

it('J12: makes a code for the chosen groups and shows its address, expiry and live status', async () => {
	const requests: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			requests.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
			return Promise.resolve(
				Response.json(
					url === '/api/support-codes'
						? {
								id: '11111111-1111-4111-8111-111111111111',
								code: '123456',
								expiresAtIso: '2026-11-08T12:00:00.000Z',
								joinCodeId: '22222222-2222-4222-8222-222222222222'
							}
						: {
								maxUses: 1,
								uses: 0,
								expiresAtIso: '2026-11-08T12:00:00.000Z',
								state: 'open',
								machines: []
							}
				)
			);
		})
	);
	const group = '33333333-3333-4333-8333-333333333333';
	const screen = await render(PhoneSupport, {
		origin: 'https://support.example.test',
		machineGroupIds: [group],
		machineGroups: [{ id: group, name: 'Support' }],
		onMachineGroupsChange: () => undefined
	});
	await screen.getByRole('button', { name: 'Create Quick join code' }).click();
	await expect.element(screen.getByText('123 456')).toBeVisible();
	await expect
		.element(screen.getByText('support.example.test/join', { exact: true }))
		.toBeVisible();
	await expect.element(screen.getByText('Waiting for a machine to join…')).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Cancel code' })).toBeVisible();
	expect(requests[0]).toEqual({ url: '/api/support-codes', body: { machineGroupIds: [group] } });
});

describe('J12: starting phone support fails visibly', () => {
	it('keeps a retry action when the server refuses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(Response.json({ message: 'Sign in again.' }, { status: 401 })))
		);
		const screen = await render(PhoneSupport, {
			origin: 'https://support.example.test',
			machineGroupIds: [],
			machineGroups: [],
			onMachineGroupsChange: () => undefined
		});
		await screen.getByRole('button', { name: 'Create Quick join code' }).click();
		await expect.element(screen.getByText('Sign in again.')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Create Quick join code' }))
			.toBeVisible();
	});
});
