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
			.element(screen.getByText(/only\s+the\s+machines\s+an\s+access\s+rule\s+opens\s+to\s+AI/))
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

	it('SPEC-MCP step 2: explains how approving a command works', async () => {
		const screen = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'on'
		});
		await expect.element(screen.getByRole('heading', { name: 'Approving commands' })).toBeVisible();
		const text = screen.container.textContent;
		expect(text).toContain('Approvals page');
		expect(text).toContain('Approve, Edit or Deny');
		expect(text).toContain('expires after 10 minutes');
		expect(text).toContain('Run commands');
		expect(text).toContain('runs as root or SYSTEM');
		expect(text).toContain('data from the machine');
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

	it('M41: explains the difference between AI can view and AI commands', async () => {
		const screen = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'on'
		});
		const view = screen.getByText(/^AI can view:/);
		await expect.element(view).toBeVisible();
		expect(view.element().textContent).toMatch(/cannot\s+ask\s+to\s+run/);
		const commands = screen.getByText(/^AI commands:/);
		await expect.element(commands).toBeVisible();
		expect(commands.element().textContent).toMatch(/approve/);
	});

	it('M42: How to connect has a choice per assistant, with this server’s address filled in', async () => {
		const url = 'https://bmuster.example.com/mcp';
		const screen = await render(AiAssistantHelp, { serverUrl: url, state: 'on' });
		await expect.element(screen.getByRole('heading', { name: 'How to connect' })).toBeVisible();
		const choices = screen.getByRole('group', { name: 'Your AI assistant' });
		for (const name of [
			'Claude Code',
			'Codex',
			'claude.ai / Claude desktop',
			'ChatGPT',
			'VS Code (Copilot)',
			'Cursor',
			'Other'
		]) {
			await expect.element(choices.getByRole('button', { name, exact: true })).toBeVisible();
		}
		// Claude Code is shown first.
		await expect
			.element(screen.getByText(`claude mcp add --transport http bmuster ${url}`))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Copy Claude Code command' }))
			.toBeVisible();
		await choices.getByRole('button', { name: 'Codex', exact: true }).click();
		await expect.element(screen.getByText(`codex mcp add bmuster --url ${url}`)).toBeVisible();
		await expect.element(screen.getByText('codex mcp login bmuster')).toBeVisible();
		await expect.element(screen.getByText(/Keep the terminal open until it prints/)).toBeVisible();
		await choices.getByRole('button', { name: 'Cursor', exact: true }).click();
		await expect
			.element(screen.getByText(`{ "mcpServers": { "bmuster": { "url": "${url}" } } }`))
			.toBeVisible();
		await choices.getByRole('button', { name: 'ChatGPT', exact: true }).click();
		await expect.element(screen.getByText(/Developer mode/)).toBeVisible();
		await choices.getByRole('button', { name: 'claude.ai / Claude desktop', exact: true }).click();
		await expect.element(screen.getByText(/Add custom connector/)).toBeVisible();
		await choices.getByRole('button', { name: 'VS Code (Copilot)', exact: true }).click();
		await expect.element(screen.getByText(/MCP: Add Server/)).toBeVisible();
		await choices.getByRole('button', { name: 'Other', exact: true }).click();
		await expect.element(screen.getByText(/client ID and secret blank/)).toBeVisible();
	});

	it('M42: notes on menus and on where each assistant connects from, a check, and the full guide', async () => {
		const screen = await render(AiAssistantHelp, {
			serverUrl: 'https://bmuster.example.com/mcp',
			state: 'on'
		});
		const text = screen.container.textContent.replace(/\s+/g, ' ');
		expect(text).toContain('Menu names in these apps change often');
		expect(text).toMatch(/claude\.ai and ChatGPT connect from their own cloud/);
		expect(text).toContain('reachable from the internet');
		expect(text).toContain('list my BMuster machines');
		expect(text).toMatch(/via <assistant>|via the assistant/);
		await expect
			.element(screen.getByRole('link', { name: 'Full guide' }))
			.toHaveAttribute('href', 'https://bmuster.com/ai-assistants');
	});
});
