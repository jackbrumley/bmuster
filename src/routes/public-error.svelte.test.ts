import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PublicError from './public-error.svelte';

function props(
	status: number,
	overrides: Partial<{ message: string; reference: string; signedIn: boolean }>
) {
	return {
		status,
		message: overrides.message ?? '',
		reference: overrides.reference,
		signedIn: overrides.signedIn ?? true,
		returnTo: '/somewhere'
	};
}

describe('root error page (SPEC-ERROR-PAGES E1)', () => {
	it('gives every status its own title and explanation, with the code small', async () => {
		const cases: [number, string, string][] = [
			[404, 'Page not found', "There's nothing at this address."],
			[403, 'Not allowed', "Your account can't open this page."],
			[401, 'Please sign in', 'You need to sign in'],
			[429, 'Too many tries', 'Wait a minute'],
			[500, 'Something went wrong', 'The server ran into a problem.'],
			[503, 'Not available right now', 'busy or starting up'],
			[418, "That didn't work", "The server couldn't handle this request."]
		];
		for (const [status, title, explanation] of cases) {
			const screen = await render(PublicError, props(status, {}));
			await expect.element(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
			await expect.element(screen.getByText(explanation, { exact: false })).toBeVisible();
			await expect.element(screen.getByText(`Error ${status}`, { exact: false })).toBeVisible();
			// The public frame, as on the sign-in page.
			await expect.element(screen.getByText('BMuster', { exact: true })).toBeVisible();
			await screen.unmount();
		}
	});

	it('offers the machine list when signed in, and sign-in when not', async () => {
		const signedIn = await render(PublicError, props(404, { signedIn: true }));
		await expect.element(signedIn.getByRole('button', { name: 'Go to Machines' })).toBeVisible();
		await expect.element(signedIn.getByRole('button', { name: 'Go back' })).toBeVisible();
		expect(signedIn.container.textContent).not.toContain('Sign in');
		await signedIn.unmount();
		const signedOut = await render(PublicError, props(404, { signedIn: false }));
		await expect.element(signedOut.getByRole('button', { name: 'Sign in' })).toBeVisible();
		await expect.element(signedOut.getByRole('button', { name: 'Go back' })).toBeVisible();
		expect(signedOut.container.textContent).not.toContain('Go to Machines');
	});

	it('offers "Try again" only for server errors', async () => {
		const notFound = await render(PublicError, props(404, {}));
		expect(notFound.container.textContent).not.toContain('Try again');
		await notFound.unmount();
		for (const status of [500, 503]) {
			const screen = await render(PublicError, props(status, {}));
			await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
			await screen.unmount();
		}
	});

	it("shows a route's own message and the error reference, never a generic message", async () => {
		const forbidden = await render(
			PublicError,
			props(403, { message: 'Only admins can open this page.' })
		);
		await expect.element(forbidden.getByText('Only admins can open this page.')).toBeVisible();
		await forbidden.unmount();
		const crashed = await render(
			PublicError,
			props(500, { message: 'Something went wrong on the server.', reference: 'ab12cd34' })
		);
		await expect.element(crashed.getByText('Error reference:', { exact: false })).toBeVisible();
		await expect.element(crashed.getByText('ab12cd34')).toBeVisible();
		expect(crashed.container.textContent).not.toContain('Something went wrong on the server.');
		await crashed.unmount();
		const missing = await render(PublicError, props(404, { message: 'Not Found' }));
		expect(missing.container.textContent).not.toContain('Not Found');
		expect(missing.container.textContent).not.toContain('Error reference');
	});
});
