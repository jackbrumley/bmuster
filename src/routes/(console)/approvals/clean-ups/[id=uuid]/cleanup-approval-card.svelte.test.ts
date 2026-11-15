import '../../../../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { CleanupApprovalView } from '#lib/domain/storage/cleanup-requests.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import CleanupApprovalCard from './cleanup-approval-card.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));

const REQUEST = '99999999-9999-4999-8999-999999999999';
const NOW = Date.parse('2026-11-15T12:00:00.000Z');

function view(state: CleanupApprovalView['state']): CleanupApprovalView {
	return {
		requestId: REQUEST,
		machine: {
			id: '00000000-0000-4000-8000-000000000001',
			name: 'mint',
			osFamily: 'linux',
			online: true
		},
		requestedBy: 'Jack Brumley',
		assistant: 'Claude Code',
		verified: true,
		reason: 'The root drive is 94 % full',
		requestedIso: new Date(NOW).toISOString(),
		expiresIso: new Date(NOW + 10 * 60_000).toISOString(),
		items: [
			{ id: 'package-cache', size: { kind: 'bytes', bytes: 2 * 1024 ** 3, files: 120 } },
			{ id: 'unused-flatpaks', size: { kind: 'unknown' } }
		],
		state
	};
}

const PENDING: CleanupApprovalView['state'] = {
	kind: 'pending',
	decide: { kind: 'yes', signIn: { kind: 'recent' } }
};

function stubServer() {
	const sent: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			sent.push({ url, body: JSON.parse(typeof init.body === 'string' ? init.body : 'null') });
			return Promise.resolve(Response.json({ requestId: REQUEST }));
		})
	);
	return sent;
}

beforeEach(async () => {
	refreshAll.mockClear();
	confirmation.current = { kind: 'none' };
	await page.viewport(390, 800);
});

describe('the clean-up approval card (SPEC-MCP M54)', () => {
	it('M54: the machine, who asked, the reason, each item with its size, and the total', async () => {
		const screen = await render(CleanupApprovalCard, { view: view(PENDING), now: NOW });
		await expect.element(screen.getByRole('heading', { name: 'mint' })).toBeVisible();
		await expect.element(screen.getByText('Jack Brumley via Claude Code (verified)')).toBeVisible();
		await expect.element(screen.getByText('Claude Code says:')).toBeVisible();
		await expect.element(screen.getByText('The root drive is 94 % full')).toBeVisible();
		await expect.element(screen.getByText('Package downloads')).toBeVisible();
		await expect.element(screen.getByText('2.0 GB in 120 files')).toBeVisible();
		await expect.element(screen.getByText('Unused Flatpak runtimes')).toBeVisible();
		await expect
			.element(screen.getByText(/Total when asked: 2\.0 GB plus an unknown amount/u))
			.toBeVisible();
		await expect.element(screen.getByText('Deletes as root')).toBeVisible();
		await expect.element(screen.getByText(/Expires in 10:00/u)).toBeVisible();
		const bar = screen.getByRole('group', { name: 'Decide' }).element();
		expect(getComputedStyle(bar).position).toBe('fixed');
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});

	it('M54: Approve waits 2 s, confirms with the total, and sends no items', async () => {
		const sent = stubServer();
		const screen = await render(CleanupApprovalCard, { view: view(PENDING), now: NOW });
		const approve = screen.getByRole('button', { name: 'Approve' });
		await expect.element(approve).toBeDisabled();
		await expect.element(approve, { timeout: 3_000 }).toBeEnabled();
		await approve.click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		const current = confirmation.current;
		if (current.kind !== 'asking') throw new Error('not asking');
		expect(current.options.title).toBe('Clean up 2 items on mint?');
		expect(current.options.message).toContain('2.0 GB plus an unknown amount');
		current.answer({ kind: 'yes', recheck: { kind: 'none' } });
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toEqual({
			url: `/api/approvals/clean-ups/${REQUEST}/approve`,
			body: { recheck: { kind: 'none' } }
		});
	});

	it('M55: Deny sends the note; a decided request shows who decided and no buttons', async () => {
		const sent = stubServer();
		const screen = await render(CleanupApprovalCard, { view: view(PENDING), now: NOW });
		await screen.getByRole('button', { name: 'Deny' }).click();
		await screen.getByLabelText('Note for the assistant (optional)').fill('Not on a weekday');
		await screen.getByRole('button', { name: 'Deny request' }).click();
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toEqual({
			url: `/api/approvals/clean-ups/${REQUEST}/deny`,
			body: { note: 'Not on a weekday' }
		});
		await screen.unmount();
		const decided = await render(CleanupApprovalCard, {
			view: view({ kind: 'denied', by: 'Bea Second', note: 'Not today' }),
			now: NOW
		});
		await expect.element(decided.getByText('Denied by Bea Second')).toBeVisible();
		await expect.element(decided.getByText(/Nothing was deleted\. Note: Not today/u)).toBeVisible();
		expect(decided.container.querySelector('[aria-label="Decide"]')).toBeNull();
	});
});
