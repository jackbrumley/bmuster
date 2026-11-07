<script lang="ts" generics="T">
	import type { DataTableColumn } from './data-table-types.ts';

	/** A column's content for one row: its `cell` snippet, or its plain value. */
	let { column, row }: { column: DataTableColumn<T>; row: T } = $props();
</script>

{#if column.cell !== undefined}
	{@render column.cell(row)}
{:else}
	{column.value(row) ?? ''}
{/if}
