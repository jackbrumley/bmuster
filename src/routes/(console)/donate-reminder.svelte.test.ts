import '../../app.css';
import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { toasts } from '#lib/ui/toast.svelte.ts';
import DonateReminder from './donate-reminder.svelte';

const FIRST =
	'BMuster is free and made by one person. If it saves you time, please consider a small donation.';
const BUSINESS = 'If BMuster supports your business, please consider giving back.';
const THANKS = 'Thanks for supporting BMuster. Still finding it useful?';

function answering(status: number) {
	const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
		const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
		const answer =
			typeof body === 'object' && body !== null && 'answer' in body ? body.answer : undefined;
		return Promise.resolve(
			new Response(
				JSON.stringify(status === 200 ? { answered: answer } : { message: 'Admins only.' }),
				{ status, headers: { 'content-type': 'application/json' } }
			)
		);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

describe('donate reminder (SPEC-DONATE)', () => {
	it('D8: Donate opens the donate page in a new tab, and nothing is fetched on its own', async () => {
		const fetch = answering(200);
		const screen = await render(DonateReminder, { wording: 'first' });
		await expect.element(screen.getByText(FIRST)).toBeVisible();
		const link = screen.getByRole('link', { name: 'Donate' });
		await expect.element(link).toHaveAttribute('href', 'https://bmuster.com/donate');
		await expect.element(link).toHaveAttribute('target', '_blank');
		await expect.element(link).toHaveAttribute('rel', 'external noopener noreferrer');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('D3: after a Not now it adds the giving-back line', async () => {
		answering(200);
		const screen = await render(DonateReminder, { wording: 'again' });
		await expect.element(screen.getByText(FIRST)).toBeVisible();
		await expect.element(screen.getByText(BUSINESS)).toBeVisible();
	});

	it('D4: after a donation it thanks them first', async () => {
		answering(200);
		const screen = await render(DonateReminder, { wording: 'thanks' });
		await expect.element(screen.getByText(THANKS)).toBeVisible();
		await expect.element(screen.getByText(BUSINESS)).not.toBeInTheDocument();
	});

	it('D3, D10: Not now sends the answer and hides the line at once', async () => {
		const fetch = answering(200);
		const screen = await render(DonateReminder, { wording: 'first' });
		await screen.getByRole('button', { name: 'Not now' }).click();
		await expect.element(screen.getByText(FIRST)).not.toBeInTheDocument();
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe('/api/settings/donate-reminder');
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe('{"answer":"not-now"}');
	});

	it('D4, D10: I have donated sends the answer and hides the line', async () => {
		const fetch = answering(200);
		const screen = await render(DonateReminder, { wording: 'first' });
		await screen.getByRole('button', { name: "I've donated, thank you" }).click();
		await expect.element(screen.getByText(FIRST)).not.toBeInTheDocument();
		expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"answer":"donated"}');
	});

	it('D10: a refusal keeps the line and says why', async () => {
		answering(403);
		const screen = await render(DonateReminder, { wording: 'first' });
		await screen.getByRole('button', { name: 'Not now' }).click();
		await expect.poll(() => toasts.list.map((toast) => toast.message)).toContain('Admins only.');
		await expect.element(screen.getByText(FIRST)).toBeVisible();
	});

	it('D9: the buttons are reachable with the keyboard', async () => {
		answering(200);
		const screen = await render(DonateReminder, { wording: 'first' });
		await expect.element(screen.getByText(FIRST)).toBeVisible();
		await page.viewport(360, 780);
		const link = screen.getByRole('link', { name: 'Donate' }).element();
		if (!(link instanceof HTMLElement)) throw new Error('Donate is not an element');
		link.focus();
		expect(document.activeElement).toBe(link);
		expect(getComputedStyle(link.closest('aside') ?? link).position).toBe('static');
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
	});
});
