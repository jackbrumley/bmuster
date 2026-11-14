<script lang="ts">
	import type { ConnectState } from '#lib/domain/mcp/mcp.ts';
	import CopyField from './copy-field.svelte';
	import Panel from './panel.svelte';

	/**
	 * What connecting an AI assistant means, in plain words (SPEC-MCP 8.5): on the Account page,
	 * where people connect one, and on Settings → AI assistants, where admins turn it on. Any
	 * assistant that speaks MCP can connect, not only Claude.
	 */
	let { serverUrl, state }: { serverUrl: string; state: ConnectState } = $props();
</script>

<Panel heading="Connect an AI assistant" actions={undefined} tone="normal" padding="normal">
	<div class="help">
		<p>
			MCP (Model Context Protocol) lets an AI assistant use BMuster as you. It works with Claude,
			ChatGPT or any other assistant that supports MCP.
		</p>
		{#if state === 'off'}
			<p class="state">AI assistants are turned off on this server. An admin can turn them on.</p>
		{:else if state === 'not-allowed'}
			<p class="state">
				You are not in the group of people who may connect an AI assistant. Ask an admin to add you.
			</p>
		{/if}
		<h3>To connect</h3>
		<ol>
			<li>In your assistant, add a custom connector (or remote MCP server) with this address:</li>
		</ol>
		<CopyField value={serverUrl} label="MCP server address" />
		<ol start="2">
			<li>
				Your browser opens BMuster. Sign in if asked, check the assistant's name, and press Allow.
			</li>
		</ol>
		<h3>What it can do</h3>
		<ul>
			<li>It sees only the machines an access rule opens to AI commands. Nothing else.</li>
			<li>
				It can ask to run commands there, and every command waits for a person to approve it in
				BMuster. Nothing runs without that approval.
			</li>
			<li>Everything it does is in Activity, as you, via the assistant.</li>
		</ul>
		<h3>Approving commands</h3>
		<ol>
			<li>
				The assistant asks to run a command, with its reason. Nothing runs yet: the request waits on
				the Approvals page, and every console you have open shows a notice with Review.
			</li>
			<li>
				The request shows the machines, the shell, the time limit and the exact command, with any
				hidden or unusual characters marked. Read it: it runs as root or SYSTEM.
			</li>
			<li>
				Choose Approve, Edit or Deny. Edit changes the command or time limit before approving; a
				note with Deny goes back to the assistant. Approving needs Run commands on every machine and
				a recent sign-in (or your password).
			</li>
			<li>
				The assistant gets the result when the command finishes. What a machine printed reaches it
				as data from the machine, never as instructions.
			</li>
		</ol>
		<p>
			A request nobody decides expires after 10 minutes, and the assistant is told. By default the
			person the assistant acts as approves; an admin can name an approvers group in Settings → AI
			assistants.
		</p>
		<h3>To disconnect</h3>
		<p>
			Press Disconnect next to it on your Account page, or remove the connector in your assistant.
			Admins can disconnect anyone, or stop all AI access, under Settings → AI assistants.
		</p>
	</div>
</Panel>

<style>
	.help {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	h3 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	ol,
	ul {
		display: grid;
		gap: var(--space-1);
		padding-left: var(--space-5);
	}

	ol {
		list-style: decimal;
	}

	ul {
		list-style: disc;
	}

	.state {
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-control);
		background: var(--warning-bg);
		color: var(--warning);
	}
</style>
