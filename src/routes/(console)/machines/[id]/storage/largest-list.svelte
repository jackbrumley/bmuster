<script lang="ts">
	import { IconFile } from '@tabler/icons-svelte-runes';
	import { splitFilePath, type LargeFile } from '#lib/domain/storage/storage.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { formatBytes } from '#lib/utils/format.ts';

	/** The largest files under the folder, from the drive's last scan (SPEC-STORAGE 7). */
	let { files, path }: { files: readonly LargeFile[]; path: string } = $props();

	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
</script>

{#snippet fileRow(file: LargeFile)}
	{@const parts = splitFilePath(file.path)}
	<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
		<span class="icon"><IconFile size={20} /></span>
		<span class="text">
			<span class="name">{parts.name}</span>
			<span class="folder">{parts.folder}</span>
			{#if file.modifiedMs !== null}
				<span class="date">Changed {dateFormat.format(file.modifiedMs)}</span>
			{/if}
		</span>
		<span class="size">{formatBytes(file.bytes)}</span>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Largest files in {path}"
	items={files}
	key={(file: LargeFile) => file.path}
	row={fileRow}
	empty="None of the drive's largest files are in this folder."
/>

<style>
	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.text {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: var(--space-1);
	}

	.name,
	.folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.name {
		font-weight: var(--weight-medium);
	}

	.folder {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}

	.date {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.size {
		flex: none;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
</style>
