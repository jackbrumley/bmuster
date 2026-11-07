<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import NoPermission from '../no-permission.svelte';
	import Button from '#lib/ui/button.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
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

	const path = $derived(machine.osFamily === 'windows' ? 'C:\\Users\\Public\\Downloads' : '/home');

	const entries = [
		{ name: 'Installers', kind: 'folder', size: '' },
		{ name: 'Scans', kind: 'folder', size: '' },
		{ name: 'printer-driver.msi', kind: 'file', size: '24 MB' },
		{ name: 'notes.txt', kind: 'file', size: '2 KB' },
		{ name: 'backup-2026-11-01.zip', kind: 'file', size: '1.2 GB' }
	] as const;
</script>

{#if !hasPermission(data.grants, 'files')}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="Files open when it checks in again."
		children={undefined}
	/>
{:else}
	<div class="browser">
		<div class="bar">
			<code class="path">{path}</code>
			<Button variant="primary" size="compact" type="button" onclick={undefined}
				><IconFileUpload size={18} /> Send a file</Button
			>
		</div>

		{#snippet entryRow(entry: (typeof entries)[number])}
			<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
				<span class="icon">
					{#if entry.kind === 'folder'}
						<IconFolder size={20} />
					{:else}
						<IconFile size={20} />
					{/if}
				</span>
				<span class="name">{entry.name}</span>
				<span class="size">{entry.size}</span>
			</ListRow>
		{/snippet}

		<ListCard
			heading={undefined}
			actions={undefined}
			label="Files in {path}"
			items={entries}
			key={(entry: (typeof entries)[number]) => entry.name}
			row={entryRow}
			empty="This folder is empty."
		/>
	</div>
{/if}

<style>
	.browser {
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

	.icon {
		display: inline-flex;
		color: var(--text-soft);
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
