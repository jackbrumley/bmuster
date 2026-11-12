import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { GuestView } from '#lib/domain/share-links/share-links.ts';
import GuestPage from './guest-page.svelte';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const REFUSAL = 'This computer is offline. Try again later.';

function guestView(overrides: Partial<GuestView>): GuestView {
	return {
		machineName: 'Front desk',
		osFamily: 'windows',
		recipient: 'Dave, Acme Printers',
		sharedByName: 'Jack Brumley',
		permissions: ['desktop-view'],
		expiresIso: new Date(Date.now() + 30 * 60_000).toISOString(),
		...overrides
	};
}

const calls: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
	calls.length = 0;
	try {
		sessionStorage.clear();
	} catch {
		// Storage can be refused; nothing to clear then.
	}
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			calls.push({
				method: init.method ?? 'GET',
				url,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			});
			return Promise.resolve(Response.json({ message: REFUSAL }, { status: 409 }));
		})
	);
});

describe('the guest page (SPEC-SHARE-LINKS)', () => {
	it('SL18: says who shared it and when it ends, with a countdown, and nothing of the console', async () => {
		const expires = new Date(Date.now() + 30 * 60_000);
		await render(GuestPage, {
			token: TOKEN,
			guest: guestView({ expiresIso: expires.toISOString() }),
			loadedAtMs: Date.now()
		});
		const endsAt = expires.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		await expect.element(page.getByRole('heading', { name: 'Front desk' })).toBeVisible();
		await expect.element(page.getByText(`Shared by Jack Brumley · ends ${endsAt}`)).toBeVisible();
		await expect
			.poll(() => page.getByRole('timer').element().textContent)
			.toMatch(/Ends in (29|30) min/);
		await expect.element(page.getByText('For Dave, Acme Printers · Watch desktop')).toBeVisible();
		await expect.element(page.getByRole('navigation')).not.toBeInTheDocument();
	});

	it('SL18, SL20: Watch needs a name first, then asks the guest endpoint as that person and shows its refusal', async () => {
		await render(GuestPage, { token: TOKEN, guest: guestView({}), loadedAtMs: Date.now() });
		await expect
			.element(page.getByRole('button', { name: 'Control the screen' }))
			.not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Watch the screen' }).click();
		await expect.element(page.getByText('Type your name.')).toBeVisible();
		expect(calls).toEqual([]);
		await page.getByRole('textbox', { name: /^Your name/ }).fill('  Alex Smith ');
		await page.getByRole('textbox', { name: /^Company or organisation/ }).fill('Acme');
		await page.getByRole('button', { name: 'Watch the screen' }).click();
		await expect
			.poll(() => calls)
			.toEqual([
				{
					method: 'POST',
					url: `/s/${TOKEN}/session`,
					body: { kind: 'desktop', mode: 'watch', name: 'Alex Smith', company: 'Acme' }
				}
			]);
		await expect.element(page.getByText(REFUSAL)).toBeVisible();
	});

	it('SL18: a control link offers Control too', async () => {
		await render(GuestPage, {
			token: TOKEN,
			guest: guestView({ permissions: ['desktop-view', 'desktop-control'] }),
			loadedAtMs: Date.now()
		});
		await expect.element(page.getByRole('button', { name: 'Control the screen' })).toBeVisible();
	});

	it('SL18: an ended link shows "This link has ended" and nothing else', async () => {
		await render(GuestPage, {
			token: TOKEN,
			guest: guestView({ expiresIso: new Date(Date.now() - 1000).toISOString() }),
			loadedAtMs: Date.now()
		});
		await expect.element(page.getByText('This link has ended')).toBeVisible();
		await expect.element(page.getByText('Front desk')).not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Watch the screen' }))
			.not.toBeInTheDocument();
	});
});
