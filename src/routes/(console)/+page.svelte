<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		IconDeviceDesktop,
		IconDevices,
		IconLockAccess,
		IconSearch,
		IconTerminal2
	} from '@tabler/icons-svelte-runes';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, formatRelative, percentOf } from '#lib/utils/format.ts';
	import { matchesSearch, osLabel, type Machine } from '#lib/domain/machines/machine.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const machines = $derived(data.view.kind === 'machines' ? data.view.machines : []);

	type Filter = 'all' | 'online' | 'offline' | 'attention';

	let query = $state('');
	let filter = $state<Filter | null>('all');

	type DiskSummary = { mount: string; percent: number; detail: string };

	function fullestDisk(machine: Machine): DiskSummary | undefined {
		if (machine.inventory.kind !== 'known' || machine.inventory.disks.length === 0) {
			return undefined;
		}
		const disk = machine.inventory.disks.reduce((worst, current) =>
			percentOf(current.usedBytes, current.sizeBytes) > percentOf(worst.usedBytes, worst.sizeBytes)
				? current
				: worst
		);
		return {
			mount: disk.mount,
			percent: percentOf(disk.usedBytes, disk.sizeBytes),
			detail: `${formatBytes(disk.sizeBytes - disk.usedBytes)} free`
		};
	}

	function pendingUpdates(machine: Machine): number {
		return machine.inventory.kind === 'known' && machine.inventory.updates.kind === 'known'
			? machine.inventory.updates.count
			: 0;
	}

	function needsAttention(machine: Machine): boolean {
		const disk = fullestDisk(machine);
		return pendingUpdates(machine) > 0 || (disk !== undefined && disk.percent >= 90);
	}

	function matchesFilter(machine: Machine): boolean {
		switch (filter ?? 'all') {
			case 'all':
				return true;
			case 'online':
				return machine.status.kind === 'online';
			case 'offline':
				return machine.status.kind === 'offline';
			case 'attention':
				return needsAttention(machine);
		}
	}

	const visible = $derived(
		machines.filter((machine) => matchesFilter(machine) && matchesSearch(machine, query))
	);

	const counts = $derived({
		all: machines.length,
		online: machines.filter((m) => m.status.kind === 'online').length,
		offline: machines.filter((m) => m.status.kind === 'offline').length,
		attention: machines.filter(needsAttention).length
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

<PageHeader title="Machines" {summary} actions={undefined} />

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
	{:else}
		<ul class="grid">
			{#each visible as machine (machine.id)}
				{@const disk = fullestDisk(machine)}
				{@const updates = pendingUpdates(machine)}
				<li>
					<Panel heading={undefined} actions={undefined} tone="normal" padding="none">
						<a class="card-link" href={resolve('/(console)/machines/[id]', { id: machine.id })}>
							<div class="card-head">
								<OsIcon family={machine.osFamily} size={28} />
								<div class="names">
									<h2>{machine.name}</h2>
									<p>{osLabel(machine)}</p>
								</div>
								<StatusBadge status={machine.status} now={data.now} />
							</div>

							<div class="meters">
								{#if machine.status.kind === 'online' && machine.live.kind === 'known'}
									<UsageBar
										label="CPU"
										percent={Math.round(machine.live.cpuPercent)}
										detail="{Math.round(machine.live.cpuPercent)}%"
									/>
									{#if machine.inventory.kind === 'known'}
										<UsageBar
											label="Memory"
											percent={percentOf(
												machine.live.memoryUsedBytes,
												machine.inventory.memoryTotalBytes
											)}
											detail="{formatBytes(machine.live.memoryUsedBytes)} of {formatBytes(
												machine.inventory.memoryTotalBytes
											)}"
										/>
									{/if}
								{/if}
								{#if disk !== undefined}
									<UsageBar label="Disk {disk.mount}" percent={disk.percent} detail={disk.detail} />
								{:else}
									<p class="pending">Waiting for the first inventory.</p>
								{/if}
							</div>

							{#if machine.lastUser.kind === 'user'}
								<p class="last-user">
									Last user: {machine.lastUser.name}, {formatRelative(
										machine.lastUser.seenIso,
										data.now
									)}
								</p>
							{/if}

							{#if updates > 0}
								<div class="tags">
									<span class="tag warn">{updates} updates</span>
								</div>
							{/if}
						</a>

						<div class="actions">
							<a
								class="action"
								class:disabled={machine.status.kind === 'offline'}
								href={resolve('/(console)/machines/[id]/terminal', { id: machine.id })}
							>
								<IconTerminal2 size={18} /> Terminal
							</a>
							<a
								class="action"
								class:disabled={machine.status.kind === 'offline'}
								href={resolve('/(console)/machines/[id]/desktop', { id: machine.id })}
							>
								<IconDeviceDesktop size={18} /> Desktop
							</a>
						</div>
					</Panel>
				</li>
			{/each}
		</ul>
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

	.pending {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The card fills its grid cell, so every card in a row is the same height. */
	li {
		display: grid;
	}

	.card-link {
		display: grid;
		align-content: start;
		gap: var(--space-4);
		padding: var(--space-4);
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}

	.names {
		flex: 1;
		min-width: 0;
	}

	h2 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.names p {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.meters {
		display: grid;
		gap: var(--space-3);
	}

	.last-user {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.tag {
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
	}

	.tag.warn {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-top: 1px solid var(--border);
	}

	.action {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 48px;
		color: var(--brand);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.action + .action {
		border-left: 1px solid var(--border);
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
