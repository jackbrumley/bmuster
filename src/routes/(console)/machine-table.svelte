<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDeviceDesktop, IconTerminal2 } from '@tabler/icons-svelte-runes';
	import DataTable from '#lib/ui/data-table/data-table.svelte';
	import type { DataTableColumn } from '#lib/ui/data-table/data-table-types.ts';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import { formatBytes, formatRelative } from '#lib/utils/format.ts';
	import { osLabel } from '#lib/domain/machines/machine.ts';
	import { inUseLabel } from '#lib/domain/sessions/session.ts';
	import type { MachineRow } from './machine-row.ts';

	/** The Table view of the Machines page: sortable columns, one line per machine on phones. */
	let {
		rows,
		now,
		batchSize,
		resetKey
	}: { rows: readonly MachineRow[]; now: number; batchSize: number; resetKey: string } = $props();

	function level(percent: number): 'normal' | 'raised' | 'high' {
		return percent >= 90 ? 'high' : percent >= 75 ? 'raised' : 'normal';
	}

	function memoryDetail({ machine }: MachineRow): string {
		if (machine.live.kind !== 'known' || machine.inventory.kind !== 'known') {
			return '';
		}
		return `${formatBytes(machine.live.memoryUsedBytes)} of ${formatBytes(machine.inventory.memoryTotalBytes)}`;
	}

	/** Online machines sort as seen now, ahead of every offline one. */
	function lastSeenValue({ machine }: MachineRow): number {
		return machine.status.kind === 'online' ? now : Date.parse(machine.lastSeenIso);
	}

	const columns: readonly DataTableColumn<MachineRow>[] = [
		{
			key: 'name',
			label: 'Name',
			align: 'left',
			sortable: true,
			value: (row) => row.machine.name,
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
			value: (row) => row.machine.status.kind,
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
			value: (row) => osLabel(row.machine),
			cell: undefined,
			link: true,
			phone: 'hidden',
			medium: 'hide'
		},
		{
			key: 'cpu',
			label: 'CPU',
			align: 'right',
			sortable: true,
			value: (row) => row.cpuPercent,
			cell: cpuCell,
			link: true,
			phone: 'hidden',
			medium: 'show'
		},
		{
			key: 'memory',
			label: 'Memory',
			align: 'right',
			sortable: true,
			value: (row) => row.memoryPercent,
			cell: memoryCell,
			link: true,
			phone: 'hidden',
			medium: 'show'
		},
		{
			key: 'disk',
			label: 'Disk',
			align: 'right',
			sortable: true,
			value: (row) => row.disk?.percent ?? null,
			cell: diskCell,
			link: true,
			phone: 'hidden',
			medium: 'show'
		},
		{
			key: 'lastUser',
			label: 'Last user',
			align: 'left',
			sortable: true,
			value: (row) => (row.machine.lastUser.kind === 'user' ? row.machine.lastUser.name : null),
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
			value: lastSeenValue,
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
	];
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
	<StatusBadge status={machine.status} {now} since="hidden" />
	{#if machine.inUse.length > 0}
		<span class="in-use">In use: {inUseLabel(machine.inUse)}</span>
	{/if}
{/snippet}

{#snippet percentText(percent: number | null, detail: string)}
	{#if percent === null}
		<span class="unknown">–</span>
	{:else}
		<span class="figure {level(percent)}" title={detail}>{percent}%</span>
	{/if}
{/snippet}

{#snippet cpuCell(row: MachineRow)}
	{@render percentText(row.cpuPercent, 'CPU')}
{/snippet}

{#snippet memoryCell(row: MachineRow)}
	{@render percentText(row.memoryPercent, memoryDetail(row))}
{/snippet}

{#snippet diskCell({ disk }: MachineRow)}
	{@render percentText(
		disk?.percent ?? null,
		disk === undefined ? '' : `${disk.mount}: ${disk.detail}`
	)}
{/snippet}

{#snippet lastSeenCell({ machine }: MachineRow)}
	{machine.status.kind === 'online' ? 'Now' : formatRelative(machine.lastSeenIso, now)}
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
	initialSort={{ column: 'name', direction: 'asc' }}
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

	.figure {
		font-variant-numeric: tabular-nums;
	}

	.figure.raised {
		color: var(--warning);
		font-weight: var(--weight-semibold);
	}

	.figure.high {
		color: var(--danger);
		font-weight: var(--weight-semibold);
	}

	.unknown {
		color: var(--muted);
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
