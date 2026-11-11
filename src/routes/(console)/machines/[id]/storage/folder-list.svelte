<script lang="ts">
	import { IconEyeOff, IconFiles, IconFolder, IconFolders } from '@tabler/icons-svelte-runes';
	import { shareOf, type FolderChild, type FolderView } from '#lib/domain/storage/storage.ts';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { formatBytes } from '#lib/utils/format.ts';

	/**
	 * One scanned folder's space (SPEC-STORAGE 7): its sub-folders biggest
	 * first, each with its share of this folder, then what is not in a
	 * sub-folder of its own: the files directly here, the small folders the
	 * scan folded in, and at the drive's root what the scan could not see.
	 */
	let {
		view,
		children,
		onopen,
		onmore
	}: {
		view: FolderView;
		/** Every page loaded so far. */
		children: readonly FolderChild[];
		onopen: (path: string) => void;
		onmore: () => void;
	} = $props();

	type Row =
		| { kind: 'folder'; child: FolderChild }
		| { kind: 'own'; bytes: number; files: number }
		| { kind: 'small'; bytes: number; folders: number }
		| { kind: 'unseen'; bytes: number };

	const count = new Intl.NumberFormat();

	const rows = $derived.by((): Row[] => {
		const list: Row[] = children.map((child) => ({ kind: 'folder', child }));
		if (view.more) {
			return list;
		}
		if (view.ownFiles > 0) {
			list.push({ kind: 'own', bytes: view.ownBytes, files: view.ownFiles });
		}
		if (view.foldedFolders > 0) {
			list.push({ kind: 'small', bytes: view.foldedBytes, folders: view.foldedFolders });
		}
		if (view.notScannedBytes > 0) {
			list.push({ kind: 'unseen', bytes: view.notScannedBytes });
		}
		return list;
	});

	function keyOf(row: Row): string {
		return row.kind === 'folder' ? `folder:${row.child.name}` : row.kind;
	}

	function plural(value: number, one: string, many: string): string {
		return `${count.format(value)} ${value === 1 ? one : many}`;
	}
</script>

{#snippet sized(name: string, bytes: number, detail: string)}
	<span class="text">
		<span class="name">{name}</span>
		<span class="detail">{formatBytes(bytes)} · {detail}</span>
		<span class="share" aria-hidden="true">
			<span class="fill" style:width="{shareOf(bytes, view.bytes)}%"></span>
		</span>
	</span>
	<span class="percent">{shareOf(bytes, view.bytes)} %</span>
{/snippet}

{#snippet folderRow(row: Row)}
	{#if row.kind === 'folder'}
		<ListRow
			action={{
				kind: 'button',
				onclick: () => {
					onopen(row.child.path);
				}
			}}
			align="center"
			dimmed={false}
		>
			<span class="icon"><IconFolder size={20} /></span>
			{@render sized(row.child.name, row.child.bytes, plural(row.child.files, 'file', 'files'))}
		</ListRow>
	{:else}
		<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
			{#if row.kind === 'own'}
				<span class="icon"><IconFiles size={20} /></span>
				{@render sized('Files in this folder', row.bytes, plural(row.files, 'file', 'files'))}
			{:else if row.kind === 'small'}
				<span class="icon"><IconFolders size={20} /></span>
				{@render sized(
					plural(row.folders, 'small folder', 'small folders'),
					row.bytes,
					'each too small to list'
				)}
			{:else}
				<span class="icon"><IconEyeOff size={20} /></span>
				{@render sized('Not scanned', row.bytes, 'system files, or folders the agent may not read')}
			{/if}
		</ListRow>
	{/if}
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Space in {view.path}"
	items={rows}
	key={keyOf}
	row={folderRow}
	empty="Nothing here takes space of its own."
/>
{#if view.more}
	<div class="more">
		<Button variant="secondary" size="compact" type="button" onclick={onmore}>Show more</Button>
	</div>
{/if}

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

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: var(--weight-medium);
	}

	.detail {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.share {
		display: block;
		height: 4px;
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		background: var(--brand);
	}

	.percent {
		flex: none;
		min-width: 48px;
		color: var(--text-soft);
		font-size: var(--text-sm);
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.more {
		display: flex;
		justify-content: center;
	}
</style>
