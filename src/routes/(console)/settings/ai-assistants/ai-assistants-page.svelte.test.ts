import '../../../../app.css';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
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
