<script lang="ts">
	import { IconFile, IconFileUnknown, IconFolder, IconLink } from '@tabler/icons-svelte-runes';
	import type { FileEntry } from '#lib/domain/files/files.ts';
	import { MAX_LIST_ENTRIES } from '#lib/domain/files/files.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { formatBytes } from '#lib/utils/format.ts';

	/**
	 * One folder's entries (SPEC-FILES F3, F9): a tick box, an icon, the
	 * name, and size and date in muted text. Tapping a folder opens it;
	 * tapping anything else opens its sheet.
	 */
	let {
		entries,
		more,
		path,
		selected,
		ontoggle,
		onopen
	}: {
		entries: readonly FileEntry[];
		more: boolean;
		path: string;
		selected: ReadonlySet<string>;
		ontoggle: (name: string, on: boolean) => void;
		onopen: (entry: FileEntry) => void;
	} = $props();

	const dateFormat = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	function meta(entry: FileEntry): string {
		const parts: string[] = [];
		if (entry.kind === 'file') {
			parts.push(formatBytes(entry.size));
		}
		if (entry.kind === 'link') {
			parts.push(`Link to ${entry.linkTarget ?? 'somewhere unknown'}`);
		}
		if (entry.modifiedMs !== null) {
			parts.push(dateFormat.format(entry.modifiedMs));
		}
		return parts.join(' · ');
	}
</script>

{#snippet entryRow(entry: FileEntry)}
	<ListRow action={{ kind: 'static' }} align="center" dimmed={entry.hidden}>
		<input
			data-raw-input="row-select"
			type="checkbox"
			class="tick"
			aria-label="Select {entry.name}"
			checked={selected.has(entry.name)}
			onchange={(event) => {
				ontoggle(entry.name, event.currentTarget.checked);
			}}
		/>
		<button
			data-raw-button="list-row"
			type="button"
			class="open"
			onclick={() => {
				onopen(entry);
			}}
		>
			<span class="icon" class:folder={entry.kind === 'folder'}>
				{#if entry.kind === 'folder'}
					<IconFolder size={22} />
				{:else if entry.kind === 'link'}
					<IconLink size={22} />
				{:else if entry.kind === 'file'}
					<IconFile size={22} />
				{:else}
					<IconFileUnknown size={22} />
				{/if}
			</span>
			<span class="text">
				<span class="name">{entry.name}</span>
				{#if meta(entry) !== ''}
					<span class="meta">{meta(entry)}</span>
				{/if}
			</span>
		</button>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Files in {path}"
	items={entries}
	key={(entry: FileEntry) => entry.name}
	row={entryRow}
	empty="This folder is empty."
/>
{#if more}
	<p class="more">
		Showing the first {MAX_LIST_ENTRIES.toLocaleString()} entries. Open a folder inside to see more.
	</p>
{/if}

<style>
	.tick {
		flex: none;
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--brand);
		cursor: pointer;
	}

	.open {
		display: flex;
		flex: 1;
		align-items: center;
		min-width: 0;
		min-height: 40px;
		gap: var(--space-3);
		padding: 0;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.icon {
		display: inline-flex;
		flex: none;
		color: var(--text-soft);
	}

	.icon.folder {
		color: var(--brand);
	}

	.text {
		display: grid;
		min-width: 0;
		gap: var(--space-0-5);
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.more {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>
