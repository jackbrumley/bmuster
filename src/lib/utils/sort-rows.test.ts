import { describe, expect, it } from 'vitest';
import { sortRows } from './sort-rows.ts';

type Row = { name: string; amount: number | null; note: string };

const rows: readonly Row[] = [
	{ name: 'mike', amount: 1200, note: 'b' },
	{ name: 'Alice', amount: 15, note: '' },
	{ name: 'bob', amount: null, note: 'a' }
];

const names = (sorted: readonly Row[]): string[] => sorted.map((row) => row.name);

describe('sortRows', () => {
	it('sorts text ignoring case, in both directions', () => {
		expect(names(sortRows(rows, (row) => row.name, 'asc'))).toEqual(['Alice', 'bob', 'mike']);
		expect(names(sortRows(rows, (row) => row.name, 'desc'))).toEqual(['mike', 'bob', 'Alice']);
	});

	it('sorts numbers by size, not as text', () => {
		const numbers: readonly Row[] = [
			{ name: 'nine', amount: 9, note: '' },
			{ name: 'eighty', amount: 80, note: '' },
			{ name: 'one hundred', amount: 100, note: '' }
		];
		expect(names(sortRows(numbers, (row) => row.amount, 'asc'))).toEqual([
			'nine',
			'eighty',
			'one hundred'
		]);
	});

	it('puts numbered names in natural order', () => {
		const pcs: readonly Row[] = ['PC-10', 'pc-2', 'PC-1'].map((name) => ({
			name,
			amount: null,
			note: ''
		}));
		expect(names(sortRows(pcs, (row) => row.name, 'asc'))).toEqual(['PC-1', 'pc-2', 'PC-10']);
	});

	it('puts empty values last in both directions', () => {
		expect(names(sortRows(rows, (row) => row.amount, 'asc'))).toEqual(['Alice', 'mike', 'bob']);
		expect(names(sortRows(rows, (row) => row.amount, 'desc'))).toEqual(['mike', 'Alice', 'bob']);
		expect(names(sortRows(rows, (row) => row.note, 'desc'))).toEqual(['mike', 'bob', 'Alice']);
	});

	it('keeps the input order for equal values, and leaves the input untouched', () => {
		const before = names(rows);
		expect(names(sortRows(rows, () => 'same', 'desc'))).toEqual(before);
		sortRows(rows, (row) => row.name, 'asc');
		expect(names(rows)).toEqual(before);
	});
});
