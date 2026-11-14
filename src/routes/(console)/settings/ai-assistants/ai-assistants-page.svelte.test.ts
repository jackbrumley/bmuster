import '../../../../app.css';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import { CONSOLE } from '../../phone-overflow-harness.ts';
import AiAssistantsPage from './+page.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example.com/settings/ai-assistants'),
		route: { id: '/(console)/settings/ai-assistants' },
		params: {},
		status: 200,
		error: null
	}
}));

const GROUP_ID = '15151515-1515-4515-8515-151515151515';

/** SPEC-MCP M41: Settings → AI assistants says which permission an access rule must give. */
describe('Settings → AI assistants (SPEC-MCP M41)', () => {
	it('M41: tells the admin to add an access rule giving AI can view or AI commands', async () => {
		const screen = await render(AiAssistantsPage, {
			params: {},
			form: undefined,
			data: {
				...CONSOLE,
				now: Date.parse('2026-11-14T00:00:00.000Z'),
				settings: { enabled: true, userGroup: { kind: 'group', id: GROUP_ID, name: 'IT' } },
				groups: [{ id: GROUP_ID, name: 'IT' }],
				approvers: { mode: 'requester', group: { kind: 'none' } },
				aiAccess: { kind: 'no-group' },
				unattended: true,
				grants: [],
				serverUrl: 'https://bmuster.example.com/mcp'
			}
		});
		const step = screen.getByText(/Then add an access rule/);
		await expect.element(step).toBeVisible();
		const text = step.element().textContent;
		expect(text).toContain('AI can view');
		expect(text).toContain('AI commands');
		await expect
			.element(screen.getByRole('link', { name: 'Access rules' }).first())
			.toHaveAttribute('href', '/access');
	});
});

function renderPage(
	aiAccess:
		| { kind: 'no-group' }
		| { kind: 'group'; canView: number; canAsk: number; viewsAll: boolean; asksAll: boolean },
	unattended: boolean
) {
	return render(AiAssistantsPage, {
		params: {},
		form: undefined,
		data: {
			...CONSOLE,
			now: Date.parse('2026-11-14T00:00:00.000Z'),
			settings: { enabled: true, userGroup: { kind: 'group', id: GROUP_ID, name: 'IT' } },
			groups: [{ id: GROUP_ID, name: 'IT' }],
			approvers: { mode: 'requester', group: { kind: 'none' } },
			aiAccess,
			unattended,
			grants: [],
			serverUrl: 'https://bmuster.example.com/mcp'
		}
	});
}

/** Records what the page sends. */
function stubSends() {
	const sent: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			sent.push({ url, body: JSON.parse(typeof init.body === 'string' ? init.body : 'null') });
			return Promise.resolve(
				Response.json(url.endsWith('/ai-access') ? { granted: true } : { allowed: false })
			);
		})
	);
	return sent;
}

async function confirmYes(): Promise<string> {
	await expect.poll(() => confirmation.current.kind).toBe('asking');
	const current = confirmation.current;
	if (current.kind !== 'asking') throw new Error('not asking');
	current.answer({ kind: 'yes', recheck: { kind: 'none' } });
	return current.options.title;
}

describe('what AI can reach (SPEC-SAVED-COMMANDS SC24, SC25)', () => {
	it('SC24: says how many machines AI can see and can ask to run commands on', async () => {
		const screen = await renderPage(
			{ kind: 'group', canView: 12, canAsk: 1, viewsAll: false, asksAll: false },
			true
		);
		await expect
			.element(screen.getByText('AI can see 12 machines; AI can ask to run commands on 1 machine.'))
			.toBeVisible();
	});

	it('SC25: each button confirms, then asks the server for the rule; buttons hide once a rule gives it', async () => {
		confirmation.current = { kind: 'none' };
		const sent = stubSends();
		const screen = await renderPage(
			{ kind: 'group', canView: 1, canAsk: 0, viewsAll: false, asksAll: false },
			true
		);
		await screen.getByRole('button', { name: 'Let AI view all machines' }).click();
		expect(await confirmYes()).toBe('Let AI view all machines?');
		await expect.poll(() => sent).toEqual([{ url: '/api/mcp/ai-access', body: { level: 'view' } }]);
		await screen.getByRole('button', { name: '…and ask to run commands on all machines' }).click();
		expect(await confirmYes()).toBe('Let AI ask to run commands on all machines?');
		await expect.poll(() => sent.length).toBe(2);
		expect(sent[1]).toEqual({ url: '/api/mcp/ai-access', body: { level: 'commands' } });
		await screen.unmount();

		const both = await renderPage(
			{ kind: 'group', canView: 3, canAsk: 3, viewsAll: true, asksAll: true },
			true
		);
		await expect.element(both.getByText(/AI can see 3 machines/)).toBeVisible();
		expect(both.getByRole('button', { name: 'Let AI view all machines' }).query()).toBeNull();
		await both.unmount();

		const none = await renderPage({ kind: 'no-group' }, true);
		await expect
			.element(none.getByText('Choose who may connect an AI assistant first.'))
			.toBeVisible();
		expect(none.getByRole('button', { name: 'Let AI view all machines' }).query()).toBeNull();
	});
});

describe('the server switch (SPEC-SAVED-COMMANDS SC21)', () => {
	it('SC21: Allow AI to run saved commands without approval, on by default, saved when changed', async () => {
		const sent = stubSends();
		const screen = await renderPage({ kind: 'no-group' }, true);
		const control = screen.getByRole('group', {
			name: 'Allow AI to run saved commands without approval'
		});
		await expect
			.element(control.getByRole('button', { name: 'On' }))
			.toHaveAttribute('aria-pressed', 'true');
		await control.getByRole('button', { name: 'Off' }).click();
		await expect
			.poll(() => sent)
			.toEqual([{ url: '/api/mcp/unattended', body: { allowed: false } }]);
	});
});
