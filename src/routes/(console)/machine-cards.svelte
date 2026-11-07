<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDeviceDesktop, IconTerminal2 } from '@tabler/icons-svelte-runes';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import ScrollBatches from '#lib/ui/scroll-batches.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UpdateBadge from '#lib/ui/update-badge.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, formatRelative } from '#lib/utils/format.ts';
	import { updateBadge } from '#lib/domain/machines/agent-updates.ts';
	import { osLabel } from '#lib/domain/machines/machine.ts';
	import { inUseLabel } from '#lib/domain/sessions/session.ts';
	import type { MachineRow } from './machine-row.ts';

	/** The Cards view of the Machines page: one card per machine, a batch at a time. */
	let {
		rows,
		now,
		batchSize,
		resetKey
	}: { rows: readonly MachineRow[]; now: number; batchSize: number; resetKey: string } = $props();
</script>

<ScrollBatches items={rows} {batchSize} {resetKey}>
	{#snippet children(shown: readonly MachineRow[])}
		<ul class="grid">
			{#each shown as { machine, disk, updates, cpuPercent, memoryPercent } (machine.id)}
				<li>
					<Panel heading={undefined} actions={undefined} tone="normal" padding="none">
						<a class="card-link" href={resolve('/(console)/machines/[id]', { id: machine.id })}>
							<div class="card-head">
								<OsIcon family={machine.osFamily} size={28} />
								<div class="names">
									<h2>{machine.name}</h2>
									<p>{osLabel(machine)}</p>
								</div>
								<StatusBadge status={machine.status} {now} since="shown" />
							</div>

							<div class="meters">
								{#if cpuPercent !== null && machine.live.kind === 'known'}
									<UsageBar label="CPU" percent={cpuPercent} detail="{cpuPercent}%" />
									{#if memoryPercent !== null && machine.inventory.kind === 'known'}
										<UsageBar
											label="Memory"
											percent={memoryPercent}
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
										now
									)}
								</p>
							{/if}

							{#if updates > 0 || machine.inUse.length > 0 || updateBadge(machine.update).kind === 'shown'}
								<div class="tags">
									{#if machine.inUse.length > 0}
										<span class="tag in-use">In use: {inUseLabel(machine.inUse)}</span>
									{/if}
									{#if updates > 0}
										<span class="tag warn">{updates} updates</span>
									{/if}
									<UpdateBadge state={machine.update} />
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
	{/snippet}
</ScrollBatches>

<style>
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

	/* minmax(0, …): a long name beside an Offline badge truncates instead of widening the card. */
	.card-link {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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

	.tag.in-use {
		background: var(--brand-tint);
		color: var(--brand);
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
