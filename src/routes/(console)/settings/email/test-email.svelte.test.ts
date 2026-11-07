import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TestEmail from './test-email.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve() }));

function replyWith(result: unknown): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(Response.json({ result })))
	);
}

describe('Send a test email (SPEC-EMAIL E2)', () => {
	it('E2: sends to the address typed and shows the server reply', async () => {
		replyWith({ kind: 'sent', reply: 'Accepted by smtp.test (Q42)' });
		const screen = await render(TestEmail, { defaultTo: 'admin@example.test' });
		await expect.element(screen.getByLabelText('Send to')).toHaveValue('admin@example.test');
		await screen.getByLabelText('Send to').fill('ops@example.test');
		await screen.getByRole('button', { name: 'Send a test email' }).click();
		await expect.element(screen.getByText(/Sent\. Accepted by smtp\.test \(Q42\)/)).toBeVisible();
		const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
		expect(init?.body).toBe(JSON.stringify({ to: 'ops@example.test' }));
	});

	it('E2: shows the exact error', async () => {
		replyWith({ kind: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:2525' });
		const screen = await render(TestEmail, { defaultTo: 'admin@example.test' });
		await screen.getByRole('button', { name: 'Send a test email' }).click();
		await expect
			.element(screen.getByText(/Not sent\. connect ECONNREFUSED 127\.0\.0\.1:2525/))
			.toBeVisible();
	});

	it('E2: refuses an address that is not one, without sending', async () => {
		replyWith({ kind: 'sent', reply: 'x' });
		const screen = await render(TestEmail, { defaultTo: 'admin@example.test' });
		await screen.getByLabelText('Send to').fill('not an address');
		await screen.getByRole('button', { name: 'Send a test email' }).click();
		await expect.element(screen.getByText('Enter an email address.')).toBeVisible();
		expect(fetch).not.toHaveBeenCalled();
	});
});
