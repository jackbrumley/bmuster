<script lang="ts">
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import type { InventoryItem } from '#lib/domain/machines/inventory-items.ts';

	/**
	 * Overview → Graphics and Network (SPEC-MACHINE-DETAILS D10, D11): one row per card or
	 * adapter from the latest inventory, or a wait until the first one arrives.
	 */
	type Row = InventoryItem & { key: string };

	let {
		heading,
		label,
		rows,
		none
	}: {
		heading: string;
		/** What the list is, for screen readers ("Network adapters"). */
		label: string;
		rows: { kind: 'waiting' } | { kind: 'known'; items: Row[] };
		/** What the card says when the inventory lists none. */
		none: string;
	} = $props();
</script>

{#snippet row(item: Row)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<div class="body">
			<p class="title">{item.title}</p>
			<p class="detail">{item.detail}</p>
		</div>
	</ListRow>
{/snippet}

<ListCard
	{heading}
	actions={undefined}
	{label}
	items={rows.kind === 'known' ? rows.items : []}
	key={(item: Row) => item.key}
	{row}
	empty={rows.kind === 'known' ? none : 'Waiting for the first inventory.'}
/>

<style>
	.body {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.detail {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
