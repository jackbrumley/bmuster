import type { CellValue, SortDirection } from './data-table-types.ts';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sorts rows by a column's value without touching the input: numbers by
 * size, text in natural order ("PC-2" before "PC-10") ignoring case. Empty
 * values (null or blank text) go last in both directions, so a column of
 * mostly-unknown figures still starts with the real ones. Equal values keep
 * their input order.
 */
export function sortRows<T>(
	rows: readonly T[],
	value: (row: T) => CellValue,
	direction: SortDirection
): readonly T[] {
	const sign = direction === 'asc' ? 1 : -1;
	return rows
		.map((row) => ({ row, value: value(row) }))
		.sort((a, b) => {
			const aEmpty = isEmpty(a.value);
			const bEmpty = isEmpty(b.value);
			if (aEmpty || bEmpty) {
				return Number(aEmpty) - Number(bEmpty);
			}
			if (typeof a.value === 'number' && typeof b.value === 'number') {
				return sign * (a.value - b.value);
			}
			return sign * collator.compare(String(a.value), String(b.value));
		})
		.map((entry) => entry.row);
}

function isEmpty(value: CellValue): boolean {
	return value === null || (typeof value === 'string' && value.trim() === '');
}
