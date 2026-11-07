<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import {
		IconFile,
		IconFileUpload,
		IconFolder,
		IconPlugConnected
	} from '@tabler/icons-svelte-runes';
	import type { PageProps } from './$types';

	/** PROTOTYPE: a pretend file browser. The real one streams through the session relay. */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);

	const path = $derived(machine.os.family === 'windows' ? 'C:\\Users\\Public\\Downloads' : '/home');

	const entries = [
		{ name: 'Installers', kind: 'folder', size: '' },
		{ name: 'Scans', kind: 'folder', size: '' },
		{ name: 'printer-driver.msi', kind: 'file', size: '24 MB' },
		{ name: 'notes.txt', kind: 'file', size: '2 KB' },
		{ name: 'backup-2026-11-01.zip', kind: 'file', size: '1.2 GB' }
	] as const;
</script>

{#if machine.status.kind === 'offline'}
	<div class="notice">
		<IconPlugConnected size={32} />
		<p>This machine is offline. Files open when it checks in again.</p>
	</div>
{:else}
	<div class="bar">
		<code class="path">{path}</code>
		<Button variant="primary" size="compact" type="button" onclick={undefined}
			><IconFileUpload size={18} /> Send a file</Button
		>
	</div>

	<ul class="list">
		{#each entries as entry (entry.name)}
			<li class="entry">
				{#if entry.kind === 'folder'}
					<IconFolder size={20} />
				{:else}
					<IconFile size={20} />
				{/if}
				<span class="name">{entry.name}</span>
				<span class="size">{entry.size}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.notice {
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

	.path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-soft);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.entry {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 52px;
		padding: 0 var(--space-4);
		color: var(--text-soft);
	}

	.entry + .entry {
		border-top: 1px solid var(--border);
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
		font-size: var(--text-sm);
	}

	.size {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
</style>
