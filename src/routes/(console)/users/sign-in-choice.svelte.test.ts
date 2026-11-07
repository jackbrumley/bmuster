import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SignInChoice from './sign-in-choice.svelte';

describe('How a new user signs in (SPEC-EMAIL E5)', () => {
	it('E5: an invitation is emailed when email is set up, and asks for no password', async () => {
		const screen = await render(SignInChoice, { choice: 'invite', password: '', emailReady: true });
		await expect.element(screen.getByText(/They get an email with a link/)).toBeVisible();
		await expect.element(screen.getByLabelText(/^Password/)).not.toBeInTheDocument();
	});

	it('E5: without email, the admin is told they get a link to pass on', async () => {
		const screen = await render(SignInChoice, {
			choice: 'invite',
			password: '',
			emailReady: false
		});
		await expect.element(screen.getByText(/you get a link to pass on/)).toBeVisible();
	});

	it('E5: "Set a password" asks for the password', async () => {
		const screen = await render(SignInChoice, { choice: 'invite', password: '', emailReady: true });
		await screen.getByRole('button', { name: 'Set a password' }).click();
		await expect.element(screen.getByLabelText(/^Password/)).toBeVisible();
	});
});
