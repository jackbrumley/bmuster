<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDeviceDesktop, IconSearch, IconTerminal2 } from '@tabler/icons-svelte-runes';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, percentOf } from '#lib/utils/format.ts';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Filter = 'all' | 'online' | 'offline' | 'attention';

	let query = $state('');
	let filter = $state<Filter>('all');

	function needsAttention(machine: Machine): boolean {
		const fullDisk = machine.disks.some((disk) => percentOf(disk.usedBytes, disk.sizeBytes) >= 90);
		return machine.os.updatesPending > 0 || fullDisk;
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
			const text = `${machine.name} ${machine.hostname} ${machine.tags.join(' ')}`.toLowerCase();
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

	function fullestDisk(machine: Machine): { percent: number; detail: string; mount: string } {
		const disk = machine.disks.reduce((worst, current) =>
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
</script>

<header class="page-head">
	<div>
		<h1>Machines</h1>
		<p class="sub">{counts.online} of {counts.all} online</p>
	</div>
</header>

<div class="toolbar">
	<label class="search">
		<IconSearch size={18} />
		<input type="search" placeholder="Search name, host or tag" bind:value={query} />
	</label>
	<div class="chips" role="group" aria-label="Filter machines">
		{#each filters as item (item.id)}
			<button
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
			<li class="card">
				<a class="card-link" href={resolve('/(console)/machines/[id]', { id: machine.id })}>
					<div class="card-head">
						<OsIcon family={machine.os.family} size={28} />
						<div class="names">
							<h2>{machine.name}</h2>
							<p>{machine.os.name} {machine.os.version}</p>
						</div>
						<StatusBadge status={machine.status} now={data.now} />
					</div>

					{#if machine.status.kind === 'online'}
						<div class="meters">
							<UsageBar
								label="CPU"
								percent={machine.cpu.loadPercent}
								detail="{machine.cpu.loadPercent}%"
							/>
							<UsageBar
								label="Memory"
								percent={percentOf(machine.memory.usedBytes, machine.memory.totalBytes)}
								detail="{formatBytes(machine.memory.usedBytes)} of {formatBytes(
									machine.memory.totalBytes
								)}"
							/>
							<UsageBar label="Disk {disk.mount}" percent={disk.percent} detail={disk.detail} />
						</div>
					{:else}
						<div class="meters">
							<UsageBar label="Disk {disk.mount}" percent={disk.percent} detail={disk.detail} />
						</div>
					{/if}

					<div class="tags">
						{#each machine.tags as tag (tag)}
							<span class="tag">{tag}</span>
						{/each}
						{#if machine.os.updatesPending > 0}
							<span class="tag warn">{machine.os.updatesPending} updates</span>
						{/if}
					</div>
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
						class:disabled={machine.status.kind === 'offline' || machine.displays === 0}
						href={resolve('/(console)/machines/[id]/desktop', { id: machine.id })}
					>
						<IconDeviceDesktop size={18} /> Desktop
					</a>
				</div>
			</li>
		{/each}
	</ul>
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
		padding: 2px var(--space-2);
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
