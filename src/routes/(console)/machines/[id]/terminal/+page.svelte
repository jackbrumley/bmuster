<script lang="ts">
	import { IconPlugConnected } from '@tabler/icons-svelte-runes';
	import { shellsFor } from '#lib/domain/machines/machine.ts';
	import type { PageProps } from './$types';

	/**
	 * PROTOTYPE: a pretend terminal to judge the layout. The real one is
	 * xterm.js over a session socket to the agent's PTY.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const shells = $derived(shellsFor(machine.os.family));

	let shellId = $state('');
	const activeShell = $derived(shells.find((shell) => shell.id === shellId) ?? shells[0]);

	const prompt = $derived(
		machine.os.family === 'windows'
			? 'PS C:\\Users\\Administrator>'
			: `${machine.signedInUser.kind === 'user' ? machine.signedInUser.name : 'root'}@${machine.hostname}:~$`
	);

	let lines = $state<string[]>([]);
	let input = $state('');

	function run(event: SubmitEvent): void {
		event.preventDefault();
		const command = input.trim();
		lines = [...lines, `${prompt} ${command}`, '(prototype: not connected to an agent yet)'];
		input = '';
	}

	const extraKeys = ['Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→', '|', '~', '/'];
</script>

{#if machine.status.kind === 'offline'}
	<div class="offline">
		<IconPlugConnected size={32} />
		<p>This machine is offline. A terminal opens when it checks in again.</p>
	</div>
{:else}
	<div class="bar">
		<div class="shells" role="group" aria-label="Shell">
			{#each shells as shell (shell.id)}
				<button
					data-raw-button="chip"
					type="button"
					class="chip"
					aria-pressed={activeShell?.id === shell.id}
					onclick={() => (shellId = shell.id)}>{shell.label}</button
				>
			{/each}
		</div>
		<span class="session">Session · 00:00</span>
	</div>

	<div class="terminal">
		<pre>{activeShell?.label} on {machine.hostname}
Connected through BMuster relay.
{#each lines as line, index (index)}{line}
			{/each}</pre>
		<form class="input-line" onsubmit={run}>
			<span class="prompt">{prompt}</span>
			<input
				data-raw-input="terminal-command"
				aria-label="Command"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				bind:value={input}
			/>
		</form>
	</div>

	<div class="keys" role="toolbar" aria-label="Extra keys">
		{#each extraKeys as key (key)}
			<button data-raw-button="key" type="button" class="key">{key}</button>
		{/each}
	</div>
{/if}

<style>
	.offline {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-12) var(--space-4);
		color: var(--muted);
		text-align: center;
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.shells {
		display: flex;
		gap: var(--space-2);
	}

	.chip {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.session {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.terminal {
		display: flex;
		flex-direction: column;
		min-height: 55dvh;
		padding: var(--space-4);
		border-radius: var(--radius-card);
		background: var(--terminal-bg);
		color: var(--terminal-text);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}

	pre {
		margin: 0;
		font: inherit;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.input-line {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.prompt {
		color: var(--terminal-prompt);
		white-space: nowrap;
	}

	.input-line input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		color: var(--terminal-text);
		font-family: var(--font-mono);
		font-size: var(--text-base);
		outline: none;
		caret-color: var(--terminal-prompt);
	}

	.keys {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-3);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.key {
		min-width: 44px;
		height: 40px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	@media (min-width: 900px) {
		.keys {
			display: none;
		}
	}
</style>
