import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-MCP M43: the public guide to connecting an AI assistant, on bmuster.com (Jekyll, served
 * from docs/), and the links to it.
 */

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the public AI assistant guide (SPEC-MCP M43)', () => {
	const guide = read('docs/ai-assistants.md');

	it('M43: is a public page at /ai-assistants', () => {
		expect(guide).toMatch(/^---\nlayout: default\n/);
		expect(guide).toContain('canonical: https://bmuster.com/ai-assistants');
		const config = read('docs/_config.yml');
		expect(config).not.toMatch(/^\s+- ai-assistants\.md$/m);
	});

	it('M43: has the admin steps, the approval model and the steps for every assistant', () => {
		expect(guide).toContain('Settings → AI assistants');
		expect(guide).toContain('AI can view');
		expect(guide).toContain('AI commands');
		expect(guide).toMatch(/approve/i);
		expect(guide).toContain('https://<your BMuster server>/mcp');
		for (const heading of [
			'Claude Code',
			'Codex',
			'claude.ai and the Claude desktop app',
			'ChatGPT',
			'VS Code',
			'Cursor',
			'Other assistants'
		]) {
			expect(guide).toContain(`### ${heading}`);
		}
		expect(guide).toContain(
			'claude mcp add --transport http bmuster https://<your BMuster server>/mcp'
		);
		expect(guide).toContain('codex mcp login bmuster');
		expect(guide).toContain('list my BMuster machines');
	});

	it('M43: the footer, the home page’s features and the README link to it', () => {
		expect(read('docs/_includes/site-footer.html')).toContain("'/ai-assistants' | relative_url");
		expect(read('docs/index.html')).toContain("'/ai-assistants' | relative_url");
		expect(read('README.md')).toContain('https://bmuster.com/ai-assistants');
	});
});
