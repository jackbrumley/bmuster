<script lang="ts" generics="T">
	import type { ResolvedPathname } from '$app/types';
	import { untrack } from 'svelte';
	import { IconArrowDown, IconArrowUp, IconArrowsSort } from '@tabler/icons-svelte-runes';
	import Panel from '../panel.svelte';
	import ScrollBatches from '../scroll-batches.svelte';
	import CellContent from './cell-content.svelte';
	import DataTablePhoneList from './data-table-phone-list.svelte';
	import type { DataTableColumn, DataTableSort } from './data-table-types.ts';
	import { sortRows } from './sort-rows.ts';

	/**
	 * The records table (AGENTS.md §12), ported from the Wannon portal. Pass
	 * `rows`, `columns` (each with a `value` and an optional `cell` snippet),
	 * `rowKey` and `rowHref`. Sortable column headings sort the rows here,
	 * by each column's `value`. Rows render a batch at a time as the person
	 * scrolls (ScrollBatches), so hundreds of rows stay quick; `resetKey`
	 * names the caller's search and filter, and a new one starts again from
	 * the top. Below 640px the table becomes a one-line-per-row list.
	 */
	let {
		label,
		columns,
		rows,
		rowKey,
		rowHref,
		initialSort,
		batchSize,
		resetKey
	}: {
		/** What the table lists, for screen readers ("Machines"). */
		label: string;
		columns: readonly DataTableColumn<T>[];
		rows: readonly T[];
		/** A stable unique key per row (usually its id). */
		rowKey: (row: T) => string;
		/** Where a row's link cells, and its phone line, go. */
		rowHref: (row: T) => ResolvedPathname;
		initialSort: DataTableSort;
		batchSize: number;
		resetKey: string;
	} = $props();

	// The starting sort only: later prop changes do not undo what the person chose.
	let sort = $state<DataTableSort>(untrack(() => initialSort));

	const sortColumn = $derived.by(() => {
		const column = columns.find((candidate) => candidate.key === sort.column);
		if (column === undefined) {
			throw new Error(`DataTable: no column "${sort.column}" to sort by`);
		}
		return column;
	});

	const sorted = $derived(sortRows(rows, sortColumn.value, sort.direction));

	/** The first link cell in a row is the one the keyboard stops at. */
	const firstLinkKey = $derived(columns.find((column) => column.link)?.key);

	function sortBy(column: DataTableColumn<T>): void {
		sort = {
			column: column.key,
			direction: sort.column === column.key && sort.direction === 'asc' ? 'desc' : 'asc'
		};
	}

	function ariaSort(column: DataTableColumn<T>): 'ascending' | 'descending' | undefined {
		if (!column.sortable || sort.column !== column.key) {
			return undefined;
		}
		return sort.direction === 'asc' ? 'ascending' : 'descending';
	}
</script>

<Panel heading={undefined} actions={undefined} tone="normal" padding="none">
	<ScrollBatches items={sorted} {batchSize} resetKey="{resetKey}|{sort.column}|{sort.direction}">
		{#snippet children(shown: readonly T[])}
			<div class="scroll">
				<table aria-label={label}>
					<thead>
						<tr>
							{#each columns as column (column.key)}
								<th
									scope="col"
									class="align-{column.align}"
									class:medium-hidden={column.medium === 'hide'}
									aria-sort={ariaSort(column)}
								>
									{#if column.sortable}
										<button
											data-raw-button="list-row"
											type="button"
											class="sort"
											class:active={sort.column === column.key}
											onclick={() => {
												sortBy(column);
											}}
										>
											{column.label}
											{#if sort.column !== column.key}
												<IconArrowsSort size={14} />
											{:else if sort.direction === 'asc'}
												<IconArrowUp size={14} />
											{:else}
												<IconArrowDown size={14} />
											{/if}
										</button>
									{:else}
										<span class="heading">{column.label}</span>
									{/if}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each shown as row (rowKey(row))}
							{@const href = rowHref(row)}
							<tr>
								{#each columns as column (column.key)}
									<td class="align-{column.align}" class:medium-hidden={column.medium === 'hide'}>
										{#if column.link}
											<a
												class="cell"
												{href}
												tabindex={column.key === firstLinkKey ? undefined : -1}
											>
												<CellContent {column} {row} />
											</a>
										{:else}
											<div class="cell"><CellContent {column} {row} /></div>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<DataTablePhoneList {label} rows={shown} {columns} {rowKey} {rowHref} />
		{/snippet}
	</ScrollBatches>
</Panel>

<style>
	.scroll {
		width: 100%;
		overflow-x: auto;
		container-type: inline-size;
	}

	@media (max-width: 640px) {
		.scroll {
			display: none;
		}
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th {
		padding: 0;
		border-bottom: 1px solid var(--border);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		white-space: nowrap;
	}

	.heading,
	.sort {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
	}

	.sort {
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		cursor: pointer;
	}

	.sort:hover,
	.sort.active {
		color: var(--brand);
	}

	.align-right .heading,
	.align-right .sort {
		justify-content: flex-end;
	}

	.align-left {
		text-align: left;
	}

	.align-right {
		text-align: right;
	}

	td {
		padding: 0;
		border-bottom: 1px solid var(--border);
		font-size: var(--text-sm);
		vertical-align: middle;
	}

	tbody tr:last-child td {
		border-bottom: none;
	}

	tbody tr:hover {
		background: var(--surface-muted);
	}

	.cell {
		display: block;
		padding: var(--space-2) var(--space-4);
		color: var(--text);
		white-space: nowrap;
	}

	/* Columns marked `medium: 'hide'` make room when the table itself is narrow. */
	@container (max-width: 1060px) {
		.medium-hidden {
			display: none;
		}
	}
</style>
