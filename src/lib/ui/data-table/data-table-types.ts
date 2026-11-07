import type { Snippet } from 'svelte';

export type SortDirection = 'asc' | 'desc';

export type DataTableSort = { column: string; direction: SortDirection };

/** What sorting compares, and what a column without a `cell` snippet shows. */
export type CellValue = string | number | null;

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
	 * badge at the row's right end, or left out.
	 */
	phone: 'primary' | 'badge' | 'hidden';
	/** `hide` drops the column while the table is narrower than 1060px, where it runs out of room. */
	medium: 'show' | 'hide';
};
