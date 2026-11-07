<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import NoPermission from '../no-permission.svelte';
	import { IconPlugConnected } from '@tabler/icons-svelte-runes';
	import { shellsFor, signedInUserOf } from '#lib/domain/machines/machine.ts';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import type { PageProps } from './$types';

	/**
	 * PROTOTYPE: a pretend terminal to judge the layout. The real one is
	 * xterm.js over a session socket to the agent's PTY.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const signedIn = $derived(signedInUserOf(machine));
	const userName = $derived(signedIn.kind === 'user' ? signedIn.name : 'root');
	const shells = $derived(shellsFor(machine.osFamily));

	let shellId = $state('');
	const activeShell = $derived(shells.find((shell) => shell.id === shellId) ?? shells[0]);

	const prompt = $derived(
		machine.osFamily === 'windows'
			? 'PS C:\\Users\\Administrator>'
			: `${userName}@${machine.hostname}:~$`
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

{#if !hasPermission(data.grants, 'terminal')}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="A terminal opens when it checks in again."
		children={undefined}
	/>
{:else}
	<div class="session">
		<div class="bar">
			<ChipGroup
				label="Shell"
				options={shells.map((shell) => ({ value: shell.id, label: shell.label, count: undefined }))}
				bind:value={
					() => activeShell?.id ?? null, (picked: string | null) => (shellId = picked ?? '')
				}
			/>
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
	</div>
{/if}

<style>
	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
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
