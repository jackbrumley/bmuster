<script lang="ts">
	import { IconDatabase, IconDeviceFloppy } from '@tabler/icons-svelte-runes';
	import type { FileRoot } from '#lib/domain/files/files.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, percentOf } from '#lib/utils/format.ts';

	/** Where browsing starts (SPEC-FILES F2): drives on Windows, mounts elsewhere, with free space. */
	let { roots, onopen }: { roots: readonly FileRoot[]; onopen: (path: string) => void } = $props();
</script>

{#snippet rootRow(root: FileRoot)}
	<ListRow
		action={{
			kind: 'button',
			onclick: () => {
				onopen(root.path);
			}
		}}
		align="center"
		dimmed={false}
	>
		<span class="icon">
			{#if root.kind === 'drive'}
				<IconDeviceFloppy size={22} />
			{:else}
				<IconDatabase size={22} />
			{/if}
		</span>
		<span class="root">
			<span class="name">{root.path}</span>
			{#if root.totalBytes !== null && root.freeBytes !== null && root.totalBytes > 0}
				<UsageBar
					label={root.label}
					percent={percentOf(root.totalBytes - root.freeBytes, root.totalBytes)}
					detail="{formatBytes(root.freeBytes)} free of {formatBytes(root.totalBytes)}"
				/>
			{:else}
				<span class="label">{root.label}</span>
			{/if}
		</span>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Drives and disks"
	items={roots}
	key={(root: FileRoot) => root.path}
	row={rootRow}
	empty="The machine listed no drives."
/>

<style>
	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.root {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: var(--space-1);
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
