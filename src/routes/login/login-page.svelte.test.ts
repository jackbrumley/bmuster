import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import LoginPage from './+page.svelte';

describe('sign-in page (SPEC-JOIN)', () => {
	it('J14: links to /join for someone enrolling a computer', async () => {
		const screen = await render(LoginPage, {
			params: {},
			data: {
				signedIn: false,
				providers: [],
				returnTo: '/',
				timedOut: false,
				canResetByEmail: false
			},
			form: null
		});
		const link = screen.getByRole('link', { name: 'Enrol this computer with a code' });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute('href')).toBe('/join');
	});

	it('S20: "Continue with" is a link, not a form, so form-action never has to allow the provider', async () => {
		const id = '0b6f9d3e-4c1a-4f2b-9a51-7d0e2c3b4a59';
		const screen = await render(LoginPage, {
			params: {},
			data: {
				signedIn: false,
				providers: [{ id, name: 'Authentik', kind: 'authentik' }],
				returnTo: '/machines?tab=all',
				timedOut: false,
				canResetByEmail: false
			},
			form: null
		});
		const link = screen.getByRole('link', { name: 'Continue with Authentik' });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute('href')).toBe(
			`/auth/oidc/${id}/start?returnTo=${encodeURIComponent('/machines?tab=all')}`
		);
		expect(link.element().closest('form')).toBeNull();
	});
});
