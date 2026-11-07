<script lang="ts" generics="T">
	import type { ResolvedPathname } from '$app/types';
	import { IconChevronRight } from '@tabler/icons-svelte-runes';
	import CellContent from './cell-content.svelte';
	import type { DataTableColumn } from './data-table-types.ts';

	/**
	 * The phone layout of a DataTable (below 640px): one line per row, the
	 * `phone: 'primary'` column with the `phone: 'badge'` column at its right,
	 * the whole line a link to the row.
	 */
	let {
		label,
		rows,
		columns,
		rowKey,
		rowHref
	}: {
		label: string;
		rows: readonly T[];
		columns: readonly DataTableColumn<T>[];
		rowKey: (row: T) => string;
		rowHref: (row: T) => ResolvedPathname;
	} = $props();

	const primary = $derived(columns.find((column) => column.phone === 'primary'));
	const badge = $derived(columns.find((column) => column.phone === 'badge'));
</script>

<ul class="list" aria-label={label}>
	{#each rows as row (rowKey(row))}
		<li>
			<a class="row" href={rowHref(row)}>
				<span class="primary">
					{#if primary !== undefined}
						<CellContent column={primary} {row} />
					{/if}
				</span>
				{#if badge !== undefined}
					<span class="badge"><CellContent column={badge} {row} /></span>
				{/if}
				<span class="chevron"><IconChevronRight size={18} /></span>
			</a>
		</li>
	{/each}
</ul>

<style>
	.list {
		display: none;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	@media (max-width: 640px) {
		.list {
			display: block;
		}
	}

	li + li {
		border-top: 1px solid var(--border);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 56px;
		padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
		color: var(--text);
	}

	.row:hover {
		background: var(--surface-muted);
	}

	.primary {
		flex: 1;
		min-width: 0;
	}

	/* A badge may take up to half the line; the name keeps the rest. */
	.badge {
		display: flex;
		flex-shrink: 1;
		justify-content: flex-end;
		min-width: 0;
		max-width: 50%;
	}

	.chevron {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--muted);
	}
</style>
