import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AiAssistantHelp from './ai-assistant-help.svelte';

/** SPEC-MCP 8.5: the plain-words explanation where people connect an assistant and admins turn it on. */
describe('Connect an AI assistant help', () => {
	it('explains MCP, the address to paste, what the assistant sees, approvals and disconnecting', async () => {
		const screen = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'on'
		});
		await expect.element(screen.getByText(/MCP \(Model Context Protocol\)/)).toBeVisible();
		await expect
			.element(screen.getByText(/Claude,\s+ChatGPT\s+or\s+any\s+other\s+assistant/))
			.toBeVisible();
		await expect.element(screen.getByText('https://bmuster.example.com/mcp')).toBeVisible();
		await expect
			.element(
				screen.getByText(/only\s+the\s+machines\s+an\s+access\s+rule\s+opens\s+to\s+AI\s+commands/)
			)
			.toBeVisible();
		await expect
			.element(
				screen.getByText(
					/every\s+command\s+waits\s+for\s+a\s+person\s+to\s+approve\s+it\s+in\s+BMuster/
				)
			)
			.toBeVisible();
		await expect.element(screen.getByRole('heading', { name: 'To disconnect' })).toBeVisible();
		expect(screen.container.textContent).not.toContain('turned off');
	});

	it('says when assistants are off, or the person may not connect one', async () => {
		const off = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'off'
		});
		await expect.element(off.getByText(/turned\s+off\s+on\s+this\s+server/)).toBeVisible();
		await off.unmount();
		const notAllowed = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'not-allowed'
		});
		await expect
			.element(notAllowed.getByText(/not\s+in\s+the\s+group\s+of\s+people/))
			.toBeVisible();
	});
});
