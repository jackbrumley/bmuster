<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, refreshAll } from '$app/navigation';
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
	import { LiveStatuses } from '#lib/runes/live-statuses.svelte.ts';
	import MachineCards from './machine-cards.svelte';
	import MachineTable from './machine-table.svelte';
	import { defaultView, readSavedView, saveView, type MachinesView } from './machines-view.ts';
	import Button from '#lib/ui/button.svelte';
	import ToggleChips from '#lib/ui/toggle-chips.svelte';
	import { COMMAND_LIMITS, type CommandDraft } from '#lib/domain/commands/commands.ts';
	import { MachineSelection, type TickBoxes } from './machine-selection.svelte.ts';
	import SelectionBar from './selection-bar.svelte';
	import DonateReminder from './donate-reminder.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Cards or rows rendered at first, and added each time the end of the list nears. */
	const BATCH_SIZE = 60;

	/**
	 * Status changes arrive live (SPEC-PRESENCE P5) and are laid over the
	 * loaded list, so the scroll position and the batches drawn stay put.
	 */
	const statuses = new LiveStatuses();
	onMount(() => statuses.connect(resolve('/api/machines/events'), refreshAll));

	const machines = $derived(
		(data.view.kind === 'machines' ? data.view.machines : []).map((machine) => ({
			...machine,
			status: statuses.statusOf(machine.id, machine.status, data.now)
		}))
	);
	const rows = $derived(machines.map(toMachineRow));
	const now = $derived(Math.max(data.now, statuses.latestAtMs));

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

	/** Select mode (SPEC-COMMANDS C1–C5), for people who may run commands somewhere. */
	const selection = new MachineSelection();
	const groups = $derived(data.commands.kind === 'allowed' ? data.commands.groups : []);
	const runnable = $derived(
		new Set(data.commands.kind === 'allowed' ? data.commands.runnable : [])
	);
	const selectChips = $derived([
		...groups.map((group) => ({ value: `group:${group.id}` as const, label: group.name })),
		{ value: 'windows' as const, label: 'Windows' },
		{ value: 'linux' as const, label: 'Linux' },
		{ value: 'online' as const, label: 'Online' }
	]);

	// In select mode the select chips stand in for the usual filter.
	const visible = $derived(
		selection.active
			? machinesMatching(rows, query, 'all').filter((row) => selection.matches(row, groups))
			: machinesMatching(rows, query, filter ?? 'all')
	);

	const ticks: TickBoxes = $derived(
		selection.active
			? {
					kind: 'on',
					canTick: (id: string) => runnable.has(id),
					isTicked: (id: string) => selection.ticked.has(id),
					toggle: (id: string) => {
						selection.toggle(id);
					}
				}
			: { kind: 'off' }
	);

	/** C3, C5: what Select all would tick, and what it skips. */
	const shownRunnable = $derived(
		visible.filter((row) => runnable.has(row.machine.id)).map((row) => row.machine.id)
	);
	const shownOthers = $derived(visible.length - shownRunnable.length);
	const selectAllLabel = $derived(
		`Select all ${shownRunnable.length}${shownOthers > 0 ? ` · ${shownOthers} you cannot run commands on` : ''}`
	);

	function runCommand(): void {
		const machineIds = rows.map((row) => row.machine.id).filter((id) => selection.ticked.has(id));
		const commandDraft: CommandDraft = {
			machineIds,
			scripts: [],
			timeoutMs: COMMAND_LIMITS.defaultTimeoutMs,
			rerunOf: null
		};
		void goto(resolve('/(console)/commands/new'), { state: { commandDraft } });
	}

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
		attention: rows.filter((row) => matchesFilter(row, 'attention')).length,
		'low-disk': rows.filter((row) => matchesFilter(row, 'low-disk')).length
	});

	const filters = $derived(
		(
			[
				{ value: 'all', label: 'All' },
				{ value: 'online', label: 'Online' },
				{ value: 'offline', label: 'Offline' },
				{ value: 'attention', label: 'Needs attention' },
				{ value: 'low-disk', label: 'Low disk' }
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
	{#if data.commands.kind === 'allowed'}
		{#if selection.active}
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => {
					selection.finish();
				}}>Done</Button
			>
		{:else}
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					selection.start();
				}}>Select</Button
			>
		{/if}
	{/if}
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
		{#if selection.active}
			<ToggleChips
				label="Narrow the machines"
				options={selectChips}
				bind:selected={selection.chips}
			/>
			{#if (selection.narrowed || query.trim() !== '') && shownRunnable.length + shownOthers > 0}
				<p class="select-all">
					<button
						data-raw-button="chip"
						type="button"
						class="select-all-link"
						onclick={() => {
							selection.tickAll(shownRunnable);
						}}
					>
						{selectAllLabel}
					</button>
				</p>
			{/if}
		{:else}
			<ChipGroup label="Filter machines" options={filters} bind:value={filter} />
		{/if}
	</div>

	{#if visible.length === 0}
		<EmptyState
			icon={IconSearch}
			title="No machines match."
			detail={undefined}
			children={undefined}
		/>
	{:else if view === 'table'}
		<MachineTable rows={visible} {now} batchSize={BATCH_SIZE} {resetKey} {ticks} bind:sort />
	{:else}
		<MachineCards rows={visible} {now} batchSize={BATCH_SIZE} {resetKey} {ticks} />
	{/if}
{/if}

{#if data.donate.kind === 'shown'}
	<DonateReminder wording={data.donate.wording} />
{/if}

{#if selection.active && selection.ticked.size > 0}
	<SelectionBar
		count={selection.ticked.size}
		onclear={() => {
			selection.ticked.clear();
		}}
		onrun={runCommand}
	/>
{/if}

<style>
	.toolbar {
		display: grid;
		gap: var(--space-3);
	}

	.select-all-link {
		min-height: 40px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--brand);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		text-align: left;
		cursor: pointer;
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
