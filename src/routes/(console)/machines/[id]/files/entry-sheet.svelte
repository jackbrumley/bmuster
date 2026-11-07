<script lang="ts">
	import { IconDownload, IconEdit, IconFolderOpen, IconTrash } from '@tabler/icons-svelte-runes';
	import type { FileEntry } from '#lib/domain/files/files.ts';
	import Button from '#lib/ui/button.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import { formatBytes } from '#lib/utils/format.ts';

	/** One file's actions (SPEC-FILES F9): Download, Rename, Delete; a link can also be opened. */
	let {
		entry,
		path,
		onopenfolder,
		ondownload,
		onrename,
		ondelete,
		onclose
	}: {
		entry: FileEntry | undefined;
		path: string;
		onopenfolder: (entry: FileEntry) => void;
		ondownload: (entry: FileEntry) => void;
		onrename: (entry: FileEntry) => void;
		ondelete: (entry: FileEntry) => void;
		onclose: () => void;
	} = $props();

	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });
</script>

<Modal open={entry !== undefined} title={entry?.name ?? ''} {onclose}>
	{#if entry !== undefined}
		<dl class="facts">
			<dt>Where</dt>
			<dd class="mono">{path}</dd>
			{#if entry.kind === 'file'}
				<dt>Size</dt>
				<dd>{formatBytes(entry.size)} ({entry.size.toLocaleString()} bytes)</dd>
			{/if}
			{#if entry.kind === 'link'}
				<dt>Links to</dt>
				<dd class="mono">{entry.linkTarget ?? 'unknown'}</dd>
			{/if}
			{#if entry.modifiedMs !== null}
				<dt>Changed</dt>
				<dd>{dateFormat.format(entry.modifiedMs)}</dd>
			{/if}
		</dl>
	{/if}
	{#snippet footer()}
		{#if entry !== undefined}
			{@const current = entry}
			<div class="actions">
				{#if current.kind === 'link'}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							onopenfolder(current);
						}}><IconFolderOpen size={18} /> Open</Button
					>
				{/if}
				{#if current.kind !== 'other'}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => {
							ondownload(current);
						}}><IconDownload size={18} /> Download</Button
					>
				{/if}
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						onrename(current);
					}}><IconEdit size={18} /> Rename</Button
				>
				<Button
					variant="danger"
					size="compact"
					type="button"
					onclick={() => {
						ondelete(current);
					}}><IconTrash size={18} /> Delete</Button
				>
			</div>
		{/if}
	{/snippet}
</Modal>

<style>
	.facts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2) var(--space-4);
		margin: 0;
		font-size: var(--text-sm);
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
		color: var(--text);
	}

	.mono {
		font-family: var(--font-mono);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
