<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import Panel from './panel.svelte';

	/**
	 * A bordered list with dividers: Activity, Users, Groups, Notes, Files,
	 * Settings. Each item renders through `row`, usually a ListRow. When the
	 * list is empty the card says `empty` instead, so every empty list looks
	 * the same.
	 */
	let {
		heading,
		actions,
		label,
		items,
		key,
		row,
		empty
	}: {
		heading: string | undefined;
		actions: Snippet | undefined;
		/** What the list is, for screen readers ("Notes, newest first"). */
		label: string;
		items: readonly T[];
		key: (item: T) => string;
		row: Snippet<[T]>;
		empty: string;
	} = $props();
</script>

<Panel {heading} {actions} tone="normal" padding="none">
	{#if items.length === 0}
		<p class="empty">{empty}</p>
	{:else}
		<ul class="list" aria-label={label}>
			{#each items as item (key(item))}
				<li class="item">{@render row(item)}</li>
			{/each}
		</ul>
	{/if}
</Panel>

<style>
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.item {
		min-width: 0;
	}

	.item + .item {
		border-top: 1px solid var(--border);
	}

	.empty {
		padding: var(--space-6) var(--space-4);
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}
</style>
