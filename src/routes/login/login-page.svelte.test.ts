import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import LoginPage from './+page.svelte';

describe('sign-in page (SPEC-JOIN)', () => {
	it('J14: links to /join for someone enrolling a computer', async () => {
		const screen = await render(LoginPage, {
			params: {},
			data: { signedIn: false, providers: [], returnTo: '/', canResetByEmail: false },
			form: null
		});
		const link = screen.getByRole('link', { name: 'Enrol this computer with a code' });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute('href')).toBe('/join');
	});
});
