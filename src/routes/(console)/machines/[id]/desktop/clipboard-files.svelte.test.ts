import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { Grant } from '#lib/domain/access/access.ts';
import type { ClipboardOffer } from '#lib/domain/session-files/session-files.ts';
import '#lib/ui/design-tokens.css';
import { CONTROL, open, SESSION, stubDesktopServer } from './desktop-test-harness.ts';

// SPEC-SESSION-FILES SF27: files copied on the machine, in the session.

const FILES: Grant[] = [...CONTROL, { permission: 'files', consent: 'unattended' }];
const OFFER_ID = '0123456789abcdef0123456789abcdef';

const asked: string[] = [];
const server: { offer: ClipboardOffer } = { offer: { kind: 'none' } };

function stubOffers(): void {
	asked.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			asked.push(url);
			if (url.includes('/session-files/offer')) {
				return Promise.resolve(Response.json(server.offer));
			}
			return Promise.resolve(Response.json({ sessionId: SESSION, browserTicket: 't-1' }));
		})
	);
}

beforeEach(async () => {
	await stubDesktopServer();
	server.offer = { kind: 'none' };
});

describe('files copied on the machine', () => {
	it('SF27: with sharing on, Download N files appears with the offer and goes when it goes', async () => {
		stubOffers();
		const { screen } = await open(FILES, 'Connect');
		stubOffers();
		server.offer = {
			kind: 'offer',
			offerId: OFFER_ID,
			items: [
				{ name: 'report.pdf', kind: 'file', size: 10 },
				{ name: 'Photos', kind: 'folder', size: 0 }
			],
			count: 2,
			totalBytes: 10
		};
		const download = screen.getByRole('button', { name: 'Download 2 files (zip)' });
		await expect.element(download, { timeout: 5000 }).toBeVisible();
		expect(asked.some((url) => url.includes(`desktopSessionId=${SESSION}`))).toBe(true);
		server.offer = {
			kind: 'offer',
			offerId: OFFER_ID,
			items: [{ name: 'report.pdf', kind: 'file', size: 10 }],
			count: 1,
			totalBytes: 10
		};
		await expect
			.element(screen.getByRole('button', { name: 'Download report.pdf' }), { timeout: 5000 })
			.toBeVisible();
		server.offer = { kind: 'none' };
		await expect
			.element(screen.getByRole('button', { name: 'Download report.pdf' }), { timeout: 5000 })
			.not.toBeInTheDocument();
	});

	it('SF27: with sharing off nothing is asked by itself; Get copied files asks once', async () => {
		const { screen } = await open(FILES, 'Connect');
		await screen.getByRole('button', { name: 'Clipboard' }).click();
		await page.getByRole('checkbox', { name: 'Share clipboard' }).click();
		stubOffers();
		server.offer = {
			kind: 'offer',
			offerId: OFFER_ID,
			items: [{ name: 'log.txt', kind: 'file', size: 3 }],
			count: 1,
			totalBytes: 3
		};
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(asked.filter((url) => url.includes('/session-files/offer'))).toEqual([]);
		await screen.getByRole('button', { name: 'Get copied files' }).click();
		await expect.element(screen.getByRole('button', { name: 'Download log.txt' })).toBeVisible();
		expect(asked.filter((url) => url.includes('/session-files/offer'))).toHaveLength(1);
	});

	it('SF27: without the files permission nothing is asked and no button shows', async () => {
		stubOffers();
		const { screen } = await open(CONTROL, 'Connect');
		await screen.getByRole('button', { name: 'Clipboard' }).click();
		await expect.element(page.getByRole('checkbox', { name: 'Share clipboard' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Get copied files' }))
			.not.toBeInTheDocument();
		expect(asked.filter((url) => url.includes('/session-files/offer'))).toEqual([]);
	});
});
