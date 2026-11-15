import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import OtherSessionsPanel from './other-sessions-panel.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn(() => Promise.resolve()) }));

const calls: { method: string; url: string }[] = [];

beforeEach(() => {
	calls.length = 0;
	if (confirmation.current.kind === 'asking') confirmation.current.answer({ kind: 'no' });
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			calls.push({ method: init.method ?? 'GET', url });
			return Promise.resolve(Response.json({ ended: 2 }));
		})
	);
});

describe('signing out everywhere else on the Account page (SPEC-SIGN-IN S21)', () => {
	it('S21: says how many other sessions there are, asks first (leaving AI assistants alone), then ends them', async () => {
		const screen = await render(OtherSessionsPanel, { others: 2 });
		await expect
			.element(screen.getByText('You are also signed in on 2 other browsers or devices.'))
			.toBeVisible();
		await screen.getByRole('button', { name: 'Sign out everywhere else' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		expect(calls).toEqual([]);
		if (confirmation.current.kind === 'asking') {
			expect(confirmation.current.options.message).toContain('This browser stays signed in');
			expect(confirmation.current.options.message).toContain('AI assistants');
			confirmation.current.answer({ kind: 'yes', recheck: { kind: 'none' } });
		}
		await expect
			.poll(() => calls)
			.toEqual([{ method: 'DELETE', url: '/api/account/other-sessions' }]);
	});

	it('S21: with no other session, says so and has nothing to end', async () => {
		const screen = await render(OtherSessionsPanel, { others: 0 });
		await expect.element(screen.getByText('Only this browser is signed in.')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Sign out everywhere else' }))
			.toBeDisabled();
	});
});
