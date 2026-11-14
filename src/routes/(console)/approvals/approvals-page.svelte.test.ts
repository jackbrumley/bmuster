import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ApprovalSummary } from '#lib/domain/commands/assistant-runs.ts';
import { LIVE_EVENT } from '#lib/schemas/commands/approvals.ts';
import { live } from '#lib/runes/live-events.svelte.ts';
import ShellFrame from '#lib/shell/shell-frame.svelte';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import ApprovalsPage from './+page.svelte';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const MEMBER = {
	id: 'm',
	name: 'Jack Brumley',
	email: 'jack@example.com',
	role: 'member'
} as const;

function request(runId: string, machineNames: string[], firstLine: string): ApprovalSummary {
	return {
		runId,
		requestedBy: 'Jack Brumley',
		assistant: 'Claude Code',
		machineNames,
		firstLine,
		requestedIso: new Date(NOW - 60_000).toISOString(),
		expiresIso: new Date(NOW + 9 * 60_000).toISOString()
	};
}

const NEWER = request('22222222-2222-4222-8222-222222222222', ['mint'], 'systemctl status restic');
const OLDER = request('11111111-1111-4111-8111-111111111111', ['reception', 'office'], 'df -h');

function data(approvals: ApprovalSummary[]) {
	return {
		user: MEMBER,
		localNetworkMode: false,
		serverUpdate: null,
		runCommands: true,
		assistant: { kind: 'none' as const },
		approvals: { kind: 'shown' as const, pending: approvals.length },
		signedIn: true,
		now: NOW,
		requests: approvals
	};
}

beforeEach(async () => {
	refreshAll.mockClear();
	FakeEventSource.opened = [];
	vi.stubGlobal('EventSource', FakeEventSource);
	live.pending = null;
	await page.viewport(1280, 800);
});

describe('the Approvals page (SPEC-MCP M26)', () => {
	it('M26: lists requests newest first; each opens its approval card', async () => {
		const screen = await render(ApprovalsPage, {
			params: {},
			form: undefined,
			data: data([NEWER, OLDER])
		});
		const links = screen
			.getByRole('list', { name: 'Requests waiting for approval, newest first' })
			.getByRole('link');
		await expect.element(links.first()).toBeVisible();
		const first = links.first().element().textContent;
		expect(first).toContain('mint');
		expect(first).toContain('systemctl status restic');
		expect(first).toContain('Jack Brumley via Claude Code');
		await expect.element(links.first()).toHaveAttribute('href', `/commands/${NEWER.runId}`);
		expect(links.nth(1).element().textContent).toContain('reception and office');
	});

	it('M26: nothing waiting shows an empty state', async () => {
		const screen = await render(ApprovalsPage, { params: {}, form: undefined, data: data([]) });
		await expect.element(screen.getByText('Nothing is waiting for your approval.')).toBeVisible();
	});

	it('M26: a new request shows a notice with Review and the count in the navigation, live', async () => {
		const children = createRawSnippet(() => ({ render: () => '<p>Page</p>' }));
		const screen = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: true,
			assistant: { kind: 'none' },
			approvals: { kind: 'shown', pending: 0 },
			children
		});
		const nav = screen.getByRole('navigation', { name: 'Main' }).first();
		await expect.element(nav.getByRole('link', { name: 'Approvals' })).toBeVisible();
		await expect
			.poll(() => FakeEventSource.opened.map((source) => source.url))
			.toEqual(['/api/live']);
		feed().send(LIVE_EVENT, { kind: 'approval-requested', approval: NEWER, pending: 1 });
		await expect
			.element(screen.getByText('Claude Code wants to run a command on mint'))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Review' }))
			.toHaveAttribute('href', `/commands/${NEWER.runId}`);
		await expect.element(nav.getByLabelText('1 waiting')).toBeVisible();
	});

	it('M26: people who may not approve have no Approvals and no live channel', async () => {
		const children = createRawSnippet(() => ({ render: () => '<p>Page</p>' }));
		const screen = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			approvals: { kind: 'hidden' },
			children
		});
		await expect.element(screen.getByText('Page')).toBeVisible();
		expect(screen.getByRole('link', { name: 'Approvals' }).query()).toBeNull();
		expect(FakeEventSource.opened).toEqual([]);
	});

	it('M26: the page reloads its list when a request arrives or is decided', async () => {
		await render(ApprovalsPage, { params: {}, form: undefined, data: data([NEWER]) });
		const children = createRawSnippet(() => ({ render: () => '<p>Frame</p>' }));
		await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: true,
			assistant: { kind: 'none' },
			approvals: { kind: 'shown', pending: 1 },
			children
		});
		await expect.poll(() => FakeEventSource.opened.length).toBe(1);
		feed().send(LIVE_EVENT, { kind: 'approval-decided', runId: NEWER.runId, pending: 0 });
		await expect.poll(() => refreshAll.mock.calls.length).toBe(1);
	});
});
