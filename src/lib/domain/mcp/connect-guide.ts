/**
 * How to connect each AI assistant to BMuster (SPEC-MCP M42), as checked with each one in
 * November 2026. The console's help panel shows these with the server's own address; the public
 * guide on bmuster.com (docs/ai-assistants.md) has the same steps with a placeholder.
 */

export const GUIDE_ASSISTANTS = [
	'claude-code',
	'codex',
	'claude-ai',
	'chatgpt',
	'vs-code',
	'cursor',
	'other'
] as const;

export type GuideAssistant = (typeof GUIDE_ASSISTANTS)[number];

/** The public guide, linked from the help panel. */
export const FULL_GUIDE_URL = 'https://bmuster.com/ai-assistants';

export function guideAssistantLabel(assistant: GuideAssistant): string {
	switch (assistant) {
		case 'claude-code':
			return 'Claude Code';
		case 'codex':
			return 'Codex';
		case 'claude-ai':
			return 'claude.ai / Claude desktop';
		case 'chatgpt':
			return 'ChatGPT';
		case 'vs-code':
			return 'VS Code (Copilot)';
		case 'cursor':
			return 'Cursor';
		case 'other':
			return 'Other';
	}
}

/** One step: what to do, and the text to paste when there is one. */
export type GuideStep = {
	text: string;
	paste: { kind: 'none' } | { kind: 'copy'; value: string; label: string };
};

const SIGN_IN = 'Your browser opens BMuster: sign in if asked, and press Allow.';

function say(text: string): GuideStep {
	return { text, paste: { kind: 'none' } };
}

function copy(text: string, value: string, label: string): GuideStep {
	return { text, paste: { kind: 'copy', value, label } };
}

/** The steps for one assistant, with `serverUrl` (this server's `<origin>/mcp`) filled in. */
export function guideSteps(assistant: GuideAssistant, serverUrl: string): GuideStep[] {
	switch (assistant) {
		case 'claude-code':
			return [
				copy(
					'In a terminal, add BMuster:',
					`claude mcp add --transport http bmuster ${serverUrl}`,
					'Claude Code command'
				),
				say('In Claude Code, type /mcp, choose bmuster, then Authenticate.'),
				say(SIGN_IN)
			];
		case 'codex':
			return [
				copy(
					'In a terminal, add BMuster (the Codex terminal and desktop app share these settings):',
					`codex mcp add bmuster --url ${serverUrl}`,
					'Codex add command'
				),
				copy('Then sign in:', 'codex mcp login bmuster', 'Codex login command'),
				say(
					`${SIGN_IN} Keep the terminal open until it prints success. A browser error page at 127.0.0.1:<port>/callback means the command was closed too early; run it again.`
				),
				say(
					'Restart the Codex app. Add BMuster as a plain MCP server like this: a Codex plugin wrapping the address did not load it in testing.'
				)
			];
		case 'claude-ai':
			return [
				say(
					'In claude.ai or the Claude desktop app (paid plans), open Settings → Connectors → Add custom connector.'
				),
				say('Name it BMuster and paste this server’s address (above).'),
				say('Press Connect, sign in to BMuster and press Allow.'),
				say(
					'The connector belongs to your Claude account, so it follows you to your other devices. On Team and Enterprise plans an owner adds it first.'
				)
			];
		case 'chatgpt':
			return [
				say(
					'In ChatGPT (paid plans), open Settings → Apps & Connectors → Advanced settings and turn Developer mode on.'
				),
				say(
					'Press Create. Name it BMuster, paste this server’s address (above), and choose OAuth for authentication.'
				),
				say('Press Connect, sign in to BMuster and press Allow.'),
				say('The connector belongs to your ChatGPT account.')
			];
		case 'vs-code':
			return [
				say('Open the Command Palette and run MCP: Add Server.'),
				say('Choose HTTP and paste this server’s address (above).'),
				say('When VS Code asks, sign in to BMuster and press Allow.')
			];
		case 'cursor':
			return [
				copy(
					'Add this to ~/.cursor/mcp.json (inside any mcpServers already there):',
					`{ "mcpServers": { "bmuster": { "url": "${serverUrl}" } } }`,
					'Cursor settings'
				),
				say('When Cursor asks you to log in to bmuster, sign in to BMuster and press Allow.')
			];
		case 'other':
			return [
				say('Look for "add MCP server", "custom connector" or "remote MCP".'),
				say('Choose HTTP (or Streamable HTTP) and paste this server’s address (above).'),
				say('Choose OAuth if asked. Leave the client ID and secret blank.'),
				say(SIGN_IN)
			];
	}
}
