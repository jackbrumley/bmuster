<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDeviceDesktop, IconSearch, IconTerminal2 } from '@tabler/icons-svelte-runes';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, percentOf } from '#lib/utils/format.ts';
	import { osLabel, type Machine } from '#lib/domain/machines/machine.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Filter = 'all' | 'online' | 'offline' | 'attention';

	let query = $state('');
	let filter = $state<Filter>('all');

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
		switch (filter) {
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
		data.machines.filter((machine) => {
			const text = `${machine.name} ${machine.hostname} ${osLabel(machine)}`.toLowerCase();
			return matchesFilter(machine) && text.includes(query.trim().toLowerCase());
		})
	);

	const counts = $derived({
		all: data.machines.length,
		online: data.machines.filter((m) => m.status.kind === 'online').length,
		offline: data.machines.filter((m) => m.status.kind === 'offline').length,
		attention: data.machines.filter(needsAttention).length
	});

	const filters: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'online', label: 'Online' },
		{ id: 'offline', label: 'Offline' },
		{ id: 'attention', label: 'Needs attention' }
	];
</script>

<header class="page-head">
	<div>
		<h1>Machines</h1>
		<p class="sub">{counts.online} of {counts.all} online</p>
	</div>
</header>

{#if data.machines.length === 0}
	<div class="first-run">
		<p>No machines yet.</p>
		<a class="first-link" href={resolve('/(console)/add')}>Add your first machine</a>
	</div>
{:else}
	<div class="toolbar">
		<label class="search">
			<IconSearch size={18} />
			<input
				data-raw-input="list-search"
				type="search"
				placeholder="Search name, host or system"
				bind:value={query}
			/>
		</label>
		<div class="chips" role="group" aria-label="Filter machines">
			{#each filters as item (item.id)}
				<button
					data-raw-button="chip"
					type="button"
					class="chip"
					aria-pressed={filter === item.id}
					onclick={() => (filter = item.id)}
				>
					{item.label}
					<span class="count">{counts[item.id]}</span>
				</button>
			{/each}
		</div>
	</div>

	{#if visible.length === 0}
		<p class="empty">No machines match.</p>
	{:else}
		<ul class="grid">
			{#each visible as machine (machine.id)}
				{@const disk = fullestDisk(machine)}
				{@const updates = pendingUpdates(machine)}
				<li class="card">
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
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	.page-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		margin-bottom: var(--space-4);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.sub {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.toolbar {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
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

	.chips {
		display: flex;
		gap: var(--space-2);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		cursor: pointer;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.count {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.first-run {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-12) 0;
		color: var(--muted);
	}

	.first-link {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}

	.pending {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.empty {
		padding: var(--space-12) 0;
		color: var(--muted);
		text-align: center;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.card {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
		overflow: hidden;
	}

	.card-link {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		flex: 1;
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
