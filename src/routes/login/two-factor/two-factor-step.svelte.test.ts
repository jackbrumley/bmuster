import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CodeStep from './+page.svelte';

describe('the code step page (SPEC-TWO-FACTOR TF18)', () => {
	it('asks for the app code with the number pad and one-time-code autofill, at 16px', async () => {
		const screen = await render(CodeStep, {
			params: {},
			data: { signedIn: false, returnTo: '/' },
			form: null
		});
		const field = screen.getByLabelText('Code from your authenticator app');
		await expect.element(field).toBeVisible();
		const input = field.element();
		expect(input.getAttribute('autocomplete')).toBe('one-time-code');
		expect(input.getAttribute('inputmode')).toBe('numeric');
		expect(input.getAttribute('name')).toBe('code');
		expect(getComputedStyle(input).fontSize).toBe('16px');
	});

	it('switches to a recovery code and back', async () => {
		const screen = await render(CodeStep, {
			params: {},
			data: { signedIn: false, returnTo: '/' },
			form: null
		});
		await screen.getByRole('button', { name: 'Use a recovery code instead' }).click();
		const field = screen.getByLabelText('Recovery code');
		await expect.element(field).toBeVisible();
		expect(field.element().getAttribute('inputmode')).toBeNull();
		await screen.getByRole('button', { name: 'Use a code from your app instead' }).click();
		await expect.element(screen.getByLabelText('Code from your authenticator app')).toBeVisible();
	});

	it('shows the server’s refusal under the field', async () => {
		const screen = await render(CodeStep, {
			params: {},
			data: { signedIn: false, returnTo: '/' },
			form: { message: 'That code is not right.' }
		});
		await expect.element(screen.getByText('That code is not right.')).toBeVisible();
		expect(screen.getByRole('textbox').element().getAttribute('aria-invalid')).toBe('true');
	});
});
