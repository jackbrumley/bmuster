<script lang="ts" generics="T">
	import type { ResolvedPathname } from '$app/types';
	import { IconChevronRight } from '@tabler/icons-svelte-runes';
	import CellContent from './cell-content.svelte';
	import type { DataTableColumn } from './data-table-types.ts';

	/**
	 * The phone layout of a DataTable (below 640px): one line per row, the
	 * `phone: 'primary'` column with the `phone: 'badge'` column at its right,
	 * the whole line a link to the row. The link holds only the primary column
	 * and stretches over the line, so the badge can hold links of its own (a
	 * link cannot sit inside a link); the badge describes the link for screen
	 * readers.
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
	const lead = $derived(columns.find((column) => column.phone === 'lead'));

	const uid = $props.id();
	const badgeId = (row: T): string => `${uid}-${rowKey(row)}-badge`;
</script>

<ul class="list" aria-label={label}>
	{#each rows as row (rowKey(row))}
		<li>
			{#if lead !== undefined}
				<span class="lead"><CellContent column={lead} {row} /></span>
			{/if}
			<a
				class="row"
				href={rowHref(row)}
				aria-describedby={badge === undefined ? undefined : badgeId(row)}
			>
				<span class="primary">
					{#if primary !== undefined}
						<CellContent column={primary} {row} />
					{/if}
				</span>
			</a>
			{#if badge !== undefined}
				<span class="badge" id={badgeId(row)}><CellContent column={badge} {row} /></span>
			{/if}
			<span class="chevron"><IconChevronRight size={18} /></span>
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

	/* The line is the row link's box: its link stretches over all of it (.row::after). */
	li {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 56px;
		padding-right: var(--space-3);
	}

	li + li {
		border-top: 1px solid var(--border);
	}

	li:hover {
		background: var(--surface-muted);
	}

	/* Above the stretched link, so the tick box and the badge's own links take their taps. */
	.lead {
		position: relative;
		z-index: 1;
		display: inline-flex;
		flex-shrink: 0;
		padding-left: var(--space-1);
	}

	.row {
		flex: 1;
		align-self: stretch;
		min-width: 0;
		overflow: hidden;
		display: flex;
		align-items: center;
		padding: var(--space-2) 0 var(--space-2) var(--space-4);
		color: var(--text);
	}

	.row::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	/* The focus ring goes round the whole line, which is what the link opens. */
	.row:focus-visible {
		outline: none;
	}

	.row:focus-visible::after {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.primary {
		flex: 1;
		min-width: 0;
	}

	/*
	 * A badge may take up to half the line; the name keeps the rest. Clicks pass through it to the
	 * row's link, except on its own links. Clipped sideways only, so a wide badge never widens the
	 * line, while a link's focus ring and tap area above and below stay whole.
	 */
	.badge {
		position: relative;
		z-index: 1;
		display: flex;
		flex-shrink: 1;
		justify-content: flex-end;
		min-width: 0;
		max-width: 50%;
		margin-left: var(--space-1);
		padding: 0 var(--space-1);
		overflow-x: clip;
		pointer-events: none;
	}

	.badge :global(a) {
		pointer-events: auto;
	}

	.chevron {
		display: inline-flex;
		flex-shrink: 0;
		margin-left: var(--space-2);
		color: var(--muted);
	}
</style>
