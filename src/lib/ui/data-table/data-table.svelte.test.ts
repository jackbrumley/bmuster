import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { resolve } from '$app/paths';
import DataTable from './data-table.svelte';
import type { DataTableColumn } from './data-table-types.ts';

type Person = { id: string; name: string; shifts: number | null };

const people: Person[] = [
	{ id: 'p1', name: 'mike', shifts: 12 },
	{ id: 'p2', name: 'Alice', shifts: 3 },
	{ id: 'p3', name: 'bob', shifts: null }
];

const shiftsCell = createRawSnippet((person: () => Person) => ({
	render: () => `<span>${String(person().shifts ?? 'none')} shifts</span>`
}));

const columns: DataTableColumn<Person>[] = [
	{
		key: 'name',
		label: 'Name',
		align: 'left',
		sortable: true,
		value: (person) => person.name,
		cell: undefined,
		link: true,
		phone: 'primary',
		medium: 'show'
	},
	{
		key: 'shifts',
		label: 'Shifts',
		align: 'right',
		sortable: true,
		value: (person) => person.shifts,
		cell: shiftsCell,
		link: true,
		phone: 'badge',
		medium: 'show'
	},
	{
		key: 'notes',
		label: 'Notes',
		align: 'left',
		sortable: false,
		value: () => 'no notes',
		cell: undefined,
		link: false,
		phone: 'hidden',
		medium: 'hide'
	}
];

function renderTable(rows: readonly Person[], batchSize: number) {
	return render(DataTable<Person>, {
		label: 'People',
		columns,
		rows,
		rowKey: (person: Person) => person.id,
		rowHref: (person: Person) => resolve('/(console)/machines/[id]', { id: person.id }),
		initialSort: { column: 'name', direction: 'asc' },
		batchSize,
		resetKey: ''
	});
}

function firstColumn(container: HTMLElement): string[] {
	return [...container.querySelectorAll('tbody tr td:first-child')].map((cell) =>
		cell.textContent.trim()
	);
}

describe('DataTable', () => {
	// Desktop width: below 640px the table becomes a list.
	beforeEach(async () => {
		await page.viewport(1280, 800);
	});

	it('renders plain values and cell snippets, sorted by the starting column', async () => {
		const screen = await renderTable(people, 60);
		await expect.element(screen.getByRole('table', { name: 'People' })).toBeVisible();
		expect(firstColumn(screen.container)).toEqual(['Alice', 'bob', 'mike']);
		await expect.element(screen.getByText('12 shifts').first()).toBeInTheDocument();
	});

	it('sorts by a heading, toggling direction, with empty values last', async () => {
		const screen = await renderTable(people, 60);
		const name = screen.getByRole('button', { name: 'Name' });
		await name.click();
		expect(firstColumn(screen.container)).toEqual(['mike', 'bob', 'Alice']);
		await expect
			.element(screen.getByRole('columnheader', { name: 'Name' }))
			.toHaveAttribute('aria-sort', 'descending');

		await screen.getByRole('button', { name: 'Shifts' }).click();
		expect(firstColumn(screen.container)).toEqual(['Alice', 'mike', 'bob']);
		await screen.getByRole('button', { name: 'Shifts' }).click();
		expect(firstColumn(screen.container)).toEqual(['mike', 'Alice', 'bob']);
		// A column that does not sort has no button.
		await expect.element(screen.getByRole('button', { name: 'Notes' })).not.toBeInTheDocument();
	});

	it('links the cells to the row, with one keyboard stop per row', async () => {
		const screen = await renderTable(people, 60);
		const href = resolve('/(console)/machines/[id]', { id: 'p2' });
		const links = screen.container.querySelectorAll(`table a[href="${href}"]`);
		expect(links).toHaveLength(2);
		expect([...links].map((link) => link.getAttribute('tabindex'))).toEqual([null, '-1']);
	});

	it('renders a batch at a time and adds more when the end scrolls near', async () => {
		const many = Array.from({ length: 150 }, (_, index) => ({
			id: `p${String(index).padStart(3, '0')}`,
			name: `Person ${String(index).padStart(3, '0')}`,
			shifts: index
		}));
		const screen = await renderTable(many, 60);
		const rows = () => screen.container.querySelectorAll('tbody tr').length;
		// The first batch only, even though the end marker is in reach at once.
		await expect.poll(rows).toBe(60);
		const end = screen.getByTestId('scroll-batches-end');
		end.element().scrollIntoView();
		await expect.poll(rows).toBe(120);
		end.element().scrollIntoView();
		await expect.poll(rows).toBe(150);
		await expect.element(end).not.toBeInTheDocument();
	});

	it('starts again from one batch when the sort changes', async () => {
		const many = Array.from({ length: 150 }, (_, index) => ({
			id: `p${String(index)}`,
			name: `Person ${String(index)}`,
			shifts: index
		}));
		// A short window, so only the first batch is near the end.
		await page.viewport(1280, 400);
		const screen = await renderTable(many, 20);
		const rows = () => screen.container.querySelectorAll('tbody tr').length;
		screen.getByTestId('scroll-batches-end').element().scrollIntoView();
		await expect.poll(rows).toBeGreaterThan(20);
		window.scrollTo(0, 0);
		await screen.getByRole('button', { name: 'Shifts' }).click();
		await expect.poll(rows).toBeLessThan(150);
		expect(firstColumn(screen.container)[0]).toBe('Person 0');
	});

	it('becomes one line per row on a phone, linking to the row', async () => {
		await page.viewport(390, 844);
		const screen = await renderTable(people, 60);
		const table = screen.container.querySelector('table');
		expect(table?.checkVisibility()).toBe(false);
		const list = screen.getByRole('list', { name: 'People' });
		await expect.element(list).toBeVisible();
		const alice = list.getByRole('link', { name: /Alice/ });
		await expect
			.element(alice)
			.toHaveAttribute('href', resolve('/(console)/machines/[id]', { id: 'p2' }));
		await expect.element(alice).toHaveTextContent('Alice 3 shifts');
	});
});
