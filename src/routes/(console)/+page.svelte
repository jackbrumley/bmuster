<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { IconDevices, IconLockAccess, IconSearch } from '@tabler/icons-svelte-runes';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import type { DataTableSort } from '#lib/ui/data-table/data-table-types.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ExportButton from '#lib/ui/export-button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import {
		machinesMatching,
		matchesFilter,
		toMachineRow,
		type MachineFilter
	} from '#lib/domain/machines/machine-row.ts';
	import MachineCards from './machine-cards.svelte';
	import MachineTable from './machine-table.svelte';
	import { defaultView, readSavedView, saveView, type MachinesView } from './machines-view.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Cards or rows rendered at first, and added each time the end of the list nears. */
	const BATCH_SIZE = 60;

	const machines = $derived(data.view.kind === 'machines' ? data.view.machines : []);
	const rows = $derived(machines.map(toMachineRow));

	let query = $state('');
	let filter = $state<MachineFilter | null>('all');

	// The view this browser picked before; read after mount (the server cannot see it).
	let picked = $state<MachinesView | undefined>(undefined);
	onMount(() => {
		picked = readSavedView();
	});
	const view = $derived(picked ?? defaultView(machines.length));

	const viewOptions = [
		{ value: 'cards', label: 'Cards', count: undefined },
		{ value: 'table', label: 'Table', count: undefined }
	] as const;

	function pickView(next: MachinesView | null): void {
		if (next !== null) {
			picked = next;
			saveView(next);
		}
	}

	const visible = $derived(machinesMatching(rows, query, filter ?? 'all'));

	// The Table view's sort, kept here so the export lists machines in the same order.
	let sort = $state<DataTableSort>({ column: 'name', direction: 'asc' });

	/**
	 * Every machine matching the search and filter, not just the batches drawn
	 * (X6): the server applies them again behind the access check. Cards view
	 * keeps the list order, so it sends no sort.
	 */
	const exportHref = $derived.by(() => {
		const search = new URLSearchParams({
			...(query.trim() === '' ? {} : { search: query.trim() }),
			...(filter === null || filter === 'all' ? {} : { filter }),
			...(view === 'table' ? { sort: sort.column, direction: sort.direction } : {})
		}).toString();
		return `${resolve('/api/exports/machines')}${search === '' ? '' : `?${search}`}`;
	});

	// A new search or filter starts the list again from the first batch.
	const resetKey = $derived(`${filter ?? 'all'}|${query}`);

	const counts = $derived({
		all: rows.length,
		online: rows.filter((row) => matchesFilter(row, 'online')).length,
		offline: rows.filter((row) => matchesFilter(row, 'offline')).length,
		attention: rows.filter((row) => matchesFilter(row, 'attention')).length
	});

	const filters = $derived(
		(
			[
				{ value: 'all', label: 'All' },
				{ value: 'online', label: 'Online' },
				{ value: 'offline', label: 'Offline' },
				{ value: 'attention', label: 'Needs attention' }
			] as const
		).map((option) => ({ ...option, count: counts[option.value] }))
	);

	const summary = $derived(
		data.view.kind === 'machines'
			? `${counts.online} of ${counts.all} online`
			: 'Machines appear here once you have access to them.'
	);
</script>

{#snippet headerActions()}
	<ChipGroup label="View" options={viewOptions} bind:value={() => view, pickView} />
	<ExportButton href={exportHref} />
{/snippet}

<PageHeader
	title="Machines"
	{summary}
	actions={data.view.kind === 'machines' && machines.length > 0 ? headerActions : undefined}
/>

{#if data.rollout.kind === 'rollout' && data.rollout.paused.kind === 'paused' && data.rollout.paused.by === 'system'}
	<Notice tone="danger" title="Agent updates are paused: version {data.rollout.version} failed">
		<p>{data.rollout.paused.reason}</p>
		<p><a href={resolve('/(console)/updates')}>Open Updates</a> to look into it and resume.</p>
	</Notice>
{/if}

{#if data.view.kind === 'awaiting-access'}
	<EmptyState
		icon={IconLockAccess}
		title="Your access hasn't been set up yet."
		detail="An admin will add you to a group that can see machines. Check back later."
		children={undefined}
	/>
{:else if machines.length === 0}
	<EmptyState icon={IconDevices} title="No machines yet." detail={undefined}>
		<a class="first-link" href={resolve('/(console)/add')}>Add your first machine</a>
	</EmptyState>
{:else}
	<div class="toolbar">
		<label class="search">
			<IconSearch size={18} />
			<input
				data-raw-input="list-search"
				type="search"
				placeholder="Search name, host, description or system"
				bind:value={query}
			/>
		</label>
		<ChipGroup label="Filter machines" options={filters} bind:value={filter} />
	</div>

	{#if visible.length === 0}
		<EmptyState
			icon={IconSearch}
			title="No machines match."
			detail={undefined}
			children={undefined}
		/>
	{:else if view === 'table'}
		<MachineTable rows={visible} now={data.now} batchSize={BATCH_SIZE} {resetKey} bind:sort />
	{:else}
		<MachineCards rows={visible} now={data.now} batchSize={BATCH_SIZE} {resetKey} />
	{/if}
{/if}

<style>
	.toolbar {
		display: grid;
		gap: var(--space-3);
	}

	.search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0 var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--muted);
	}

	.search input {
		flex: 1;
		min-width: 0;
		height: 44px;
		border: none;
		background: transparent;
		color: var(--text);
		font-size: var(--text-base);
		outline: none;
	}

	.first-link {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}
</style>
