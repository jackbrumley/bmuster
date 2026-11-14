import '../../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ApprovalView } from '#lib/domain/commands/assistant-runs.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import ApprovalCard from './approval-card.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));

const RUN = '99999999-9999-4999-8999-999999999999';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function view(overrides: Partial<ApprovalView> = {}): ApprovalView {
	return {
		runId: RUN,
		requestedBy: 'Jack Brumley',
		assistant: 'Claude Code',
		verified: true,
		reason: 'Check whether the backup unit failed',
		requestedIso: new Date(NOW).toISOString(),
		expiresIso: new Date(NOW + 10 * 60_000).toISOString(),
		osFamily: 'linux',
		shell: 'bash',
		command: 'systemctl status restic-backup.service',
		timeoutMs: 60_000,
		machines: [
			{ id: '00000000-0000-4000-8000-000000000001', name: 'mint', plan: 'runs' },
			{ id: '00000000-0000-4000-8000-000000000002', name: 'reception', plan: 'offline' }
		],
		decide: { kind: 'yes', signIn: { kind: 'recent' } },
		...overrides
	};
}

/** The server: records what the card sends. */
function stubServer() {
	const sent: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			sent.push({ url, body: JSON.parse(typeof init.body === 'string' ? init.body : 'null') });
			return Promise.resolve(Response.json({ runId: RUN }));
		})
	);
	return sent;
}

async function answerYes(): Promise<string> {
	await expect.poll(() => confirmation.current.kind).toBe('asking');
	const current = confirmation.current;
	if (current.kind !== 'asking') throw new Error('not asking');
	const message = current.options.message;
	current.answer({ kind: 'yes', password: '' });
	return message;
}

beforeEach(async () => {
	refreshAll.mockClear();
	confirmation.current = { kind: 'none' };
	await page.viewport(1280, 800);
});

describe('the approval card (SPEC-MCP M25)', () => {
	it('M25: the exact command in full, the machines and shell above it, and the assistant’s reason', async () => {
		const long = `echo ${'a'.repeat(2990)}`;
		const screen = await render(ApprovalCard, { view: view({ command: long }), now: NOW });
		await expect.element(screen.getByRole('heading', { name: 'mint, reception' })).toBeVisible();
		await expect.element(screen.getByText('bash', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Claude Code says:')).toBeVisible();
		await expect.element(screen.getByText('Check whether the backup unit failed')).toBeVisible();
		await expect.element(screen.getByText('Jack Brumley via Claude Code (verified)')).toBeVisible();
		await expect.element(screen.getByText('Runs as root')).toBeVisible();
		await expect.element(screen.getByText('1 line · 2,995 characters')).toBeVisible();
		const box = screen.getByTestId('command');
		await expect.element(box).toHaveTextContent(long);
		const style = getComputedStyle(box.element());
		expect(style.whiteSpace).toBe('pre-wrap');
		expect(style.fontFamily).toMatch(/mono/iu);
		// M30: Deny and Approve sit in a bar fixed to the bottom of the screen.
		const bar = screen.getByRole('group', { name: 'Decide' }).element();
		expect(getComputedStyle(bar).position).toBe('fixed');
	});

	it('M25: invisible and unusual characters are shown as visible markers', async () => {
		const screen = await render(ApprovalCard, {
			view: view({ command: 'ls\u200B /tmp && echo p\u0430ss' }),
			now: NOW
		});
		await expect.element(screen.getByText('zero-width space')).toBeVisible();
		await expect
			.element(screen.getByTitle('U+0430 in an otherwise plain word'))
			.toHaveTextContent('\u0430');
		await expect
			.element(screen.getByText('2 hidden or unusual characters are marked'))
			.toBeVisible();
	});

	it('M25: Approve stays disabled for 2 s after the card appears, then approves as shown', async () => {
		const sent = stubServer();
		const screen = await render(ApprovalCard, { view: view(), now: NOW });
		const approve = screen.getByRole('button', { name: 'Approve' });
		await expect.element(approve).toBeDisabled();
		await expect.element(approve, { timeout: 3_000 }).toBeEnabled();
		await approve.click();
		expect(await answerYes()).toContain('systemctl status restic-backup.service');
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toEqual({
			url: `/api/commands/runs/${RUN}/approve`,
			body: {
				command: 'systemctl status restic-backup.service',
				timeoutMs: 60_000,
				confirmCount: 2,
				password: { kind: 'none' }
			}
		});
	});

	it('M25: Edit shows the command to change, a before and after on confirm, and re-arms Approve', async () => {
		const sent = stubServer();
		const screen = await render(ApprovalCard, { view: view({ command: 'echo one' }), now: NOW });
		await screen.getByRole('button', { name: 'Edit' }).click();
		const box = screen.getByRole('textbox', { name: 'Command to approve' });
		await box.fill('echo two');
		const approve = screen.getByRole('button', { name: 'Approve edited' });
		await expect.element(approve).toBeDisabled();
		await expect.element(approve, { timeout: 3_000 }).toBeEnabled();
		await approve.click();
		const message = await answerYes();
		expect(message).toContain('Before: echo one');
		expect(message).toContain('After: echo two');
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]?.body).toMatchObject({ command: 'echo two' });
	});

	it('M25: Deny sends the note; someone who cannot approve can still deny', async () => {
		const sent = stubServer();
		const screen = await render(ApprovalCard, {
			view: view({ decide: { kind: 'no', why: 'You cannot run commands on mint.' } }),
			now: NOW
		});
		await expect.element(screen.getByText('You cannot run commands on mint.')).toBeVisible();
		expect(screen.getByRole('button', { name: 'Approve' }).query()).toBeNull();
		await screen.getByRole('button', { name: 'Deny' }).click();
		await screen
			.getByRole('textbox', { name: 'Note for the assistant (optional)' })
			.fill('Not today');
		await screen.getByRole('button', { name: 'Deny request' }).click();
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toEqual({
			url: `/api/commands/runs/${RUN}/deny`,
			body: { note: 'Not today' }
		});
	});
});
