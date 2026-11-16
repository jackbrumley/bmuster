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
	/**
	 * How the cell opens the row (`rowHref`): `cell`, the whole cell is the row's link; `behind`,
	 * the row's link lies behind the content, so the content may hold links of its own (a link cannot
	 * sit inside a link) and a click anywhere else in the cell still opens the row; `none`, the cell
	 * holds its own controls and does not open the row.
	 */
	link: 'cell' | 'behind' | 'none';
	/**
	 * Its place in the phone list (below 640px): the row's main content, the
	 * badge at the row's right end, a control before the row's link (a
	 * selection tick box), or left out.
	 */
	phone: 'primary' | 'badge' | 'lead' | 'hidden';
	/** `hide` drops the column while the table is narrower than 1060px, where it runs out of room. */
	medium: 'show' | 'hide';
};
