<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDeviceDesktop, IconTerminal2 } from '@tabler/icons-svelte-runes';
	import DataTable from '#lib/ui/data-table/data-table.svelte';
	import type { DataTableColumn, DataTableSort } from '#lib/ui/data-table/data-table-types.ts';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UpdateBadge from '#lib/ui/update-badge.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import { inUseLabel } from '#lib/domain/sessions/session.ts';
	import { machineSortValue, type MachineRow } from '#lib/domain/machines/machine-row.ts';
	import LowDiskTag from './low-disk-tag.svelte';

	/**
	 * The Table view of the Machines page: sortable columns, one line per
	 * machine on phones. `sort` is bound so the page's export keeps the order.
	 */
	let {
		rows,
		now,
		batchSize,
		resetKey,
		sort = $bindable()
	}: {
		rows: readonly MachineRow[];
		now: number;
		batchSize: number;
		resetKey: string;
		sort: DataTableSort;
	} = $props();

	// Derived: the Last seen column compares online machines as seen `now`.
	const columns: readonly DataTableColumn<MachineRow>[] = $derived([
		{
			key: 'name',
			label: 'Name',
			align: 'left',
			sortable: true,
			value: machineSortValue('name', now),
			cell: nameCell,
			link: true,
			phone: 'primary',
			medium: 'show'
		},
		{
			key: 'status',
			label: 'Status',
			align: 'left',
			sortable: true,
			value: machineSortValue('status', now),
			cell: statusCell,
			link: true,
			phone: 'badge',
			medium: 'show'
		},
		{
			key: 'os',
			label: 'OS',
			align: 'left',
			sortable: true,
			value: machineSortValue('os', now),
			cell: undefined,
			link: true,
			phone: 'hidden',
			medium: 'hide'
		},
		{
			key: 'lastUser',
			label: 'Last user',
			align: 'left',
			sortable: true,
			value: machineSortValue('lastUser', now),
			cell: undefined,
			link: true,
			phone: 'hidden',
			medium: 'hide'
		},
		{
			key: 'lastSeen',
			label: 'Last seen',
			align: 'left',
			sortable: true,
			value: machineSortValue('lastSeen', now),
			cell: lastSeenCell,
			link: true,
			phone: 'hidden',
			medium: 'show'
		},
		{
			key: 'actions',
			label: 'Open',
			align: 'right',
			sortable: false,
			value: () => null,
			cell: actionsCell,
			link: false,
			phone: 'hidden',
			medium: 'show'
		}
	]);
</script>

{#snippet nameCell({ machine, updates }: MachineRow)}
	<span class="name">
		<OsIcon family={machine.osFamily} size={20} />
		<span class="names">
			<span class="title">{machine.name}</span>
			<span class="host">
				{machine.hostname}{#if updates > 0}<span class="updates"
						>· {updates} {updates === 1 ? 'update' : 'updates'}</span
					>{/if}
			</span>
		</span>
	</span>
{/snippet}

{#snippet statusCell({ machine }: MachineRow)}
	<span class="status">
		<StatusBadge status={machine.status} {now} since="hidden" />
		<UpdateBadge state={machine.update} />
	</span>
	{#if machine.inUse.length > 0}
		<span class="in-use">In use: {inUseLabel(machine.inUse)}</span>
	{/if}
	{#if machine.lowDisk.length > 0}
		<LowDiskTag drives={machine.lowDisk} />
	{/if}
{/snippet}

{#snippet lastSeenCell({ machine }: MachineRow)}
	{machine.status.kind === 'online' ? 'Now' : formatRelative(machine.status.sinceIso, now)}
{/snippet}

{#snippet actionsCell({ machine }: MachineRow)}
	<span class="actions">
		<a
			class="action"
			class:disabled={machine.status.kind === 'offline'}
			href={resolve('/(console)/machines/[id]/terminal', { id: machine.id })}
			aria-label="Terminal on {machine.name}"
			title="Terminal"
		>
			<IconTerminal2 size={18} />
		</a>
		<a
			class="action"
			class:disabled={machine.status.kind === 'offline'}
			href={resolve('/(console)/machines/[id]/desktop', { id: machine.id })}
			aria-label="Desktop on {machine.name}"
			title="Desktop"
		>
			<IconDeviceDesktop size={18} />
		</a>
	</span>
{/snippet}

<DataTable
	label="Machines"
	{columns}
	{rows}
	rowKey={(row: MachineRow) => row.machine.id}
	rowHref={(row: MachineRow) => resolve('/(console)/machines/[id]', { id: row.machine.id })}
	bind:sort
	{batchSize}
	{resetKey}
/>

<style>
	.in-use {
		display: block;
		margin-top: var(--space-1);
		color: var(--brand);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	/* Names keep room to be read; a table too wide for the screen scrolls sideways. */
	.name {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		max-width: 320px;
	}

	.names {
		min-width: 160px;
	}

	.names {
		display: grid;
	}

	.title {
		overflow: hidden;
		font-weight: var(--weight-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.host {
		overflow: hidden;
		color: var(--muted);
		font-size: var(--text-xs);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.updates {
		margin-left: var(--space-1);
		color: var(--warning);
	}

	.status {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
	}

	.actions {
		display: inline-flex;
		gap: var(--space-1);
	}

	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-pill);
		color: var(--brand);
	}

	.action:hover {
		background: var(--brand-tint);
	}

	.action.disabled {
		color: var(--muted);
		pointer-events: none;
		opacity: 0.6;
	}
</style>
