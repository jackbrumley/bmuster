import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import SendMessage from './send-message.svelte';

const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
	calls.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
			return Promise.resolve(Response.json({ sent: true }));
		})
	);
});

describe('Send message (Overview)', () => {
	it('posts the text for the machine and closes', async () => {
		const machine = { ...TEST_MACHINE, osFamily: 'windows' as const };
		const screen = await render(SendMessage, { machine });
		await screen.getByRole('button', { name: 'Send message' }).click();
		await page.getByRole('textbox', { name: 'Message' }).fill('Rebooting at 5');
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await expect
			.poll(() => calls)
			.toEqual([{ url: `/api/machines/${machine.id}/message`, body: { text: 'Rebooting at 5' } }]);
		await expect.element(page.getByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
	});

	it('says what is wrong with an empty message and sends nothing', async () => {
		const screen = await render(SendMessage, { machine: TEST_MACHINE });
		await screen.getByRole('button', { name: 'Send message' }).click();
		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await expect.element(page.getByText('Write a message first.')).toBeVisible();
		expect(calls).toEqual([]);
	});
});
