<script lang="ts">
	import { IconDownload, IconTrash, IconX } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';

	/** Shown once anything is ticked (SPEC-FILES F9): "3 selected · Download · Delete · Clear". */
	let {
		count,
		ondownload,
		ondelete,
		onclear
	}: {
		count: number;
		ondownload: () => void;
		ondelete: () => void;
		onclear: () => void;
	} = $props();
</script>

<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
	<div class="bar" role="toolbar" aria-label="Selected items">
		<span class="count">{count} selected</span>
		<div class="actions">
			<Button variant="secondary" size="compact" type="button" onclick={ondownload}
				><IconDownload size={18} /> Download</Button
			>
			<Button variant="danger" size="compact" type="button" onclick={ondelete}
				><IconTrash size={18} /> Delete</Button
			>
			<Button variant="secondary" size="compact" type="button" onclick={onclear}
				><IconX size={18} /> Clear</Button
			>
		</div>
	</div>
</Panel>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.count {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
