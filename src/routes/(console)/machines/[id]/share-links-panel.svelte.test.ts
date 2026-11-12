import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ShareLinkView } from '#lib/domain/share-links/share-links.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import ShareLinks from './share-links.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const URL_ONCE = 'https://bmuster.test/s/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function linkView(overrides: Partial<ShareLinkView>): ShareLinkView {
	return {
		id: LINK_ID,
		machineId: MACHINE_ID,
		machineName: 'Front desk',
		recipient: 'Dave, Acme Printers',
		permissions: ['desktop-view'],
		createdByName: 'Jack',
		createdIso: new Date().toISOString(),
		expiresIso: new Date(Date.now() + 65 * 60_000).toISOString(),
		lastUse: { kind: 'never' },
		...overrides
	};
}

const calls: { method: string; url: string; body: unknown }[] = [];

function stubServer(options: { existing: ShareLinkView[]; canControl: boolean }): void {
	calls.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			const method = init.method ?? 'GET';
			calls.push({
				method,
				url,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			});
			if (method === 'GET') {
				return Promise.resolve(
					Response.json({
						links: options.existing,
						canTick: { control: options.canControl, files: false }
					})
				);
			}
			if (method === 'POST') {
				return Promise.resolve(
					Response.json(
						{ link: linkView({ id: '33333333-3333-4333-8333-333333333333' }), url: URL_ONCE },
						{ status: 201 }
					)
				);
			}
			return Promise.resolve(Response.json({ ended: true }));
		})
	);
}

beforeEach(() => {
	if (confirmation.current.kind === 'asking') confirmation.current.answer(false);
});

describe('Share links on the machine page (SPEC-SHARE-LINKS)', () => {
	it('SL17: lists active links with what they allow, who made them and time left', async () => {
		stubServer({ existing: [linkView({})], canControl: false });
		await render(ShareLinks, { machineId: MACHINE_ID, machineName: 'Front desk' });
		await expect.element(page.getByText('Dave, Acme Printers')).toBeVisible();
		await expect
			.element(page.getByText(/Watch desktop · by Jack · 1 h \d+ min left/))
			.toBeVisible();
	});

	it('SL20: each link says who last used it, as they named themselves, and from where', async () => {
		stubServer({
			existing: [
				linkView({}),
				linkView({
					id: '44444444-4444-4444-8444-444444444444',
					recipient: 'Eve, Beta Plumbing',
					lastUse: {
						kind: 'used',
						name: 'Alex Smith',
						company: 'Acme',
						address: '203.0.113.5',
						atIso: new Date(Date.now() - 5 * 60_000).toISOString()
					}
				})
			],
			canControl: false
		});
		await render(ShareLinks, { machineId: MACHINE_ID, machineName: 'Front desk' });
		await expect.element(page.getByText('Not used yet')).toBeVisible();
		await expect
			.element(
				page.getByText(
					/^Last used by someone who says they are Alex Smith \(Acme\), from 203\.0\.113\.5, /
				)
			)
			.toBeVisible();
	});

	it('SL17: Create sends the recipient, duration and ticks, then shows the link once with Copy', async () => {
		stubServer({ existing: [], canControl: true });
		const screen = await render(ShareLinks, { machineId: MACHINE_ID, machineName: 'Front desk' });
		await screen.getByRole('button', { name: 'Share' }).click();
		await page.getByRole('textbox', { name: 'Who it is for' }).fill('Dave, Acme Printers');
		await expect
			.element(
				page.getByText(
					'The guest connects without asking the person at the machine first. They will see that someone is connected and can disconnect them.'
				)
			)
			.toBeVisible();
		await page.getByRole('button', { name: '7 days' }).click();
		await page.getByRole('checkbox', { name: 'Control desktop' }).click();
		await page.getByRole('button', { name: 'Create link' }).click();
		await expect
			.poll(() => calls.filter((call) => call.method === 'POST'))
			.toEqual([
				{
					method: 'POST',
					url: `/api/machines/${MACHINE_ID}/share-links`,
					body: { recipient: 'Dave, Acme Printers', duration: '7d', control: true, files: false }
				}
			]);
		await expect.element(page.getByText(URL_ONCE)).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Copy share link' })).toBeVisible();
		await page.getByRole('button', { name: 'Done' }).click();
		await expect.element(page.getByText(URL_ONCE)).not.toBeInTheDocument();
	});

	it('SL17: Control is offered only to people who may control; an empty label is refused here', async () => {
		stubServer({ existing: [], canControl: false });
		const screen = await render(ShareLinks, { machineId: MACHINE_ID, machineName: 'Front desk' });
		await screen.getByRole('button', { name: 'Share' }).click();
		await expect.element(page.getByText('Watch desktop (always)')).toBeVisible();
		await expect
			.element(page.getByRole('checkbox', { name: 'Control desktop' }))
			.not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Create link' }).click();
		await expect.element(page.getByText('Say who the link is for.')).toBeVisible();
		expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
	});

	it('SL17: End now asks first, and ends nothing when cancelled', async () => {
		stubServer({ existing: [linkView({})], canControl: false });
		const screen = await render(ShareLinks, { machineId: MACHINE_ID, machineName: 'Front desk' });
		const end = screen.getByRole('button', { name: 'End now' });
		await end.click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') confirmation.current.answer(false);
		await new Promise((done) => setTimeout(done, 20));
		expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);

		await end.click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') confirmation.current.answer(true);
		await expect
			.poll(() => calls.filter((call) => call.method === 'DELETE').map((call) => call.url))
			.toEqual([`/api/share-links/${LINK_ID}`]);
		await expect.element(page.getByText('Dave, Acme Printers')).not.toBeInTheDocument();
	});
});
