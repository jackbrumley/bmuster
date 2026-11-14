import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { GrantView } from '#lib/domain/mcp/mcp.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import AccountPage from './+page.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve() }));

const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-11-14T10:00:00.000Z');

const GRANT: GrantView = {
	id: GRANT_ID,
	assistant: { name: 'Claude Code', identity: { kind: 'verified', host: 'claude.ai' } },
	userName: 'Jack Brumley',
	createdIso: '2026-11-10T10:00:00.000Z',
	lastUsed: { kind: 'used', atIso: '2026-11-14T09:58:00.000Z', ip: '198.51.100.7' },
	active: true
};

const calls: { method: string; url: string }[] = [];

beforeEach(() => {
	calls.length = 0;
	if (confirmation.current.kind === 'asking') confirmation.current.answer({ kind: 'no' });
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			calls.push({ method: init.method ?? 'GET', url });
			return Promise.resolve(Response.json({ disconnected: true }));
		})
	);
});

function renderAccount(grants: GrantView[]) {
	return render(AccountPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: 'u', name: 'Jack Brumley', email: 'jack@example.com', role: 'member' },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: false,
			assistant: { kind: 'connected', name: 'Claude Code' },
			approvals: { kind: 'hidden' },
			signedIn: true,
			now: NOW,
			signIn: ['Password'],
			connect: 'on',
			serverUrl: 'https://bmuster.example.com/mcp',
			grants
		}
	});
}

describe('the Account page (SPEC-MCP M10)', () => {
	it('M10: lists connected assistants: client, verified or not, connected on, last used and address', async () => {
		const screen = await renderAccount([GRANT]);
		await expect.element(screen.getByText('Jack Brumley', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Claude Code', { exact: false }).first()).toBeVisible();
		await expect.element(screen.getByText('Verified: claude.ai')).toBeVisible();
		await expect.element(screen.getByText(/from 198\.51\.100\.7/)).toBeVisible();
		await expect.element(screen.getByText('Active now')).toBeVisible();
	});

	it('M10: Disconnect asks first, then ends the grant', async () => {
		const screen = await renderAccount([GRANT]);
		await screen.getByRole('button', { name: 'Disconnect' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		expect(calls).toEqual([]);
		if (confirmation.current.kind === 'asking') {
			confirmation.current.answer({ kind: 'yes', password: '' });
		}
		await expect
			.poll(() => calls)
			.toEqual([{ method: 'DELETE', url: `/api/mcp/grants/${GRANT_ID}` }]);
	});

	it('M10: says when nothing is connected, and how to connect one', async () => {
		const screen = await renderAccount([]);
		await expect.element(screen.getByText('No AI assistant is connected.')).toBeVisible();
		await expect.element(screen.getByText('https://bmuster.example.com/mcp')).toBeVisible();
	});
});
