import '../../../app.css';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Consent from './consent.svelte';

/** SPEC-MCP M7: what a person sees before an AI assistant may act as them. */

const FIELDS = [
	{ name: 'client_id', value: 'https://claude.ai/oauth/claude-code-client-metadata' },
	{ name: 'state', value: 'abc' }
];

describe('the consent screen (SPEC-MCP M7)', () => {
	it('M7: names the assistant and its host, where it returns to, what it may do, with Allow and Cancel', async () => {
		const screen = await render(Consent, {
			view: {
				kind: 'ask',
				assistant: { name: 'Claude', identity: { kind: 'verified', host: 'claude.ai' } },
				redirect: { kind: 'web', host: 'claude.ai' },
				scopes: ['machines:read', 'offline_access']
			},
			fields: FIELDS,
			userName: 'Jack Brumley',
			outcome: { kind: 'none' }
		});
		await expect
			.element(screen.getByRole('heading', { name: 'Claude wants to act as you on BMuster' }))
			.toBeVisible();
		await expect.element(screen.getByText(/Its details come from/)).toBeVisible();
		await expect.element(screen.getByText(/Afterwards you go back to/)).toBeVisible();
		await expect
			.element(screen.getByText(/See the machines an access rule opens to AI/))
			.toBeVisible();
		await expect
			.element(
				screen.getByText(
					"It acts as you. Every command still needs a person's approval in BMuster."
				)
			)
			.toBeVisible();
		const allow = screen.getByRole('button', { name: 'Allow' });
		const cancel = screen.getByRole('button', { name: 'Cancel' });
		await expect.element(allow).toBeVisible();
		await expect.element(cancel).toBeVisible();
		expect(allow.element().closest('form')?.getAttribute('action')).toBe('?/allow');
		expect(cancel.element().closest('form')?.getAttribute('action')).toBe('?/cancel');
		// Both post the request back as it came.
		const posted = new FormData(allow.element().closest('form') ?? undefined);
		expect(posted.get('state')).toBe('abc');
		expect(posted.get('client_id')).toBe(FIELDS[0]?.value);
	});

	it('M39: the scope lines say viewing needs AI can view and asking needs AI commands', async () => {
		const screen = await render(Consent, {
			view: {
				kind: 'ask',
				assistant: { name: 'Claude', identity: { kind: 'verified', host: 'claude.ai' } },
				redirect: { kind: 'web', host: 'claude.ai' },
				scopes: ['machines:read', 'commands:run']
			},
			fields: FIELDS,
			userName: 'Jack Brumley',
			outcome: { kind: 'none' }
		});
		await expect
			.element(
				screen.getByText(
					/See the machines an access rule opens to AI \(AI can view or AI commands\)/
				)
			)
			.toBeVisible();
		await expect
			.element(screen.getByText(/Ask to run commands on the machines where you have AI commands/))
			.toBeVisible();
	});

	it('M7: warns about an unverified assistant and a loopback redirect', async () => {
		const screen = await render(Consent, {
			view: {
				kind: 'ask',
				assistant: { name: 'Totally Claude', identity: { kind: 'unverified' } },
				redirect: { kind: 'loopback' },
				scopes: ['machines:read']
			},
			fields: FIELDS,
			userName: 'Jack Brumley',
			outcome: { kind: 'none' }
		});
		await expect.element(screen.getByText('Unverified assistant')).toBeVisible();
		await expect.element(screen.getByText('Returns to a program on this computer')).toBeVisible();
	});

	it('M7: someone outside the connect group is told so, and can only cancel', async () => {
		const screen = await render(Consent, {
			view: {
				kind: 'not-allowed',
				assistant: { name: 'Claude', identity: { kind: 'verified', host: 'claude.ai' } }
			},
			fields: FIELDS,
			userName: 'Jack Brumley',
			outcome: { kind: 'none' }
		});
		await expect.element(screen.getByText('You cannot connect an AI assistant')).toBeVisible();
		expect(screen.container.querySelector('form[action="?/allow"]')).toBeNull();
		await expect.element(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
	});
});
