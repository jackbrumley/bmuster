import type { Snippet } from 'svelte';
import type { CellValue, SortDirection } from '#lib/utils/sort-rows.ts';

export type DataTableSort = { column: string; direction: SortDirection };

export type DataTableColumn<T> = {
	key: string;
	label: string;
	align: 'left' | 'right';
	sortable: boolean;
	/** The cell's plain value: shown when `cell` is undefined, and what sorting compares. */
	value: (row: T) => CellValue;
	/** Custom cell content; undefined shows `value`. */
	cell: Snippet<[T]> | undefined;
	/** The cell opens the row (`rowHref`). Leave it off for cells with their own links. */
	link: boolean;
	/**
	 * Its place in the phone list (below 640px): the row's main content, the
	 * badge at the row's right end, a control before the row's link (a
	 * selection tick box), or left out.
	 */
	phone: 'primary' | 'badge' | 'lead' | 'hidden';
	/** `hide` drops the column while the table is narrower than 1060px, where it runs out of room. */
	medium: 'show' | 'hide';
};
