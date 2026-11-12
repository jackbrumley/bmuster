<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import Panel from '#lib/ui/panel.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, formatDuration, formatRelative, percentOf } from '#lib/utils/format.ts';
	import { adapterItem, gpuItem } from '#lib/domain/machines/inventory-items.ts';
	import { osLabel, signedInUserOf } from '#lib/domain/machines/machine.ts';
	import { powerSourceLabel } from '#lib/domain/machines/power.ts';
	import { inUseLabel } from '#lib/domain/sessions/session.ts';
	import { canSendUserMessage } from '#lib/domain/machines/user-message.ts';
	import { hasPermission } from '#lib/domain/access/access.ts';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import DisplayCard from './display-card.svelte';
	import LowDiskNotice from './low-disk-notice.svelte';
	import InventoryList from './inventory-list.svelte';
	import SendMessage from './send-message.svelte';
	import ShareLinks from './share-links.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const user = $derived(signedInUserOf(machine));
	// The machine page's one live status, the header's too (SPEC-PRESENCE P10).
	const presence = machinePresence();
	const status = $derived(presence.status);

	// Live figures: refresh while the page is visible (the server asks the agent to stream).
	onMount(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refreshAll();
			}
		}, 3000);
		return () => {
			clearInterval(timer);
		};
	});

	const facts = $derived.by(() => {
		const list = [
			...(machine.inUse.length > 0 ? [{ label: 'In use', value: inUseLabel(machine.inUse) }] : []),
			{ label: 'Operating system', value: osLabel(machine) },
			{ label: 'Signed in', value: user.kind === 'user' ? user.name : 'Nobody' },
			{
				label: 'Last user',
				value:
					machine.lastUser.kind === 'user'
						? `${machine.lastUser.name}, ${formatRelative(machine.lastUser.seenIso, data.now)}`
						: 'None seen yet'
			},
			{ label: 'Agent', value: `v${machine.agentVersion}` },
			{
				label: 'Last seen',
				value: status.kind === 'online' ? 'Now' : formatRelative(status.sinceIso, data.now)
			},
			{ label: 'Enrolled', value: formatRelative(machine.enrolledIso, data.now) },
			// A live figure: stale once the machine is offline (D12).
			...(status.kind === 'online' && machine.live.kind === 'known'
				? [{ label: 'Uptime', value: formatDuration(machine.live.uptimeSeconds) }]
				: [])
		];
		if (machine.inventory.kind === 'known') {
			const inventory = machine.inventory;
			list.push(
				{
					label: 'Updates',
					value:
						inventory.updates.kind === 'unknown'
							? 'Not reported'
							: inventory.updates.count === 0
								? 'Up to date'
								: `${inventory.updates.count} pending`
				},
				{ label: 'Processor', value: `${inventory.cpuModel} · ${inventory.cpuCores} cores` },
				{ label: 'Memory', value: formatBytes(inventory.memoryTotalBytes) },
				{ label: 'Build', value: inventory.osBuild === '' ? 'Not reported' : inventory.osBuild },
				{ label: 'Power', value: powerSourceLabel(inventory.power) }
			);
		}
		return list;
	});

	// Two identical cards are two rows, so graphics rows are keyed by position.
	const graphics = $derived(
		machine.inventory.kind === 'known'
			? {
					kind: 'known' as const,
					items: machine.inventory.gpus.map((gpu, index) => ({
						key: String(index),
						...gpuItem(gpu)
					}))
				}
			: { kind: 'waiting' as const }
	);

	const network = $derived(
		machine.inventory.kind === 'known'
			? {
					kind: 'known' as const,
					items: machine.inventory.network.map((adapter) => ({
						key: adapter.name,
						...adapterItem(adapter)
					}))
				}
			: { kind: 'waiting' as const }
	);
</script>

{#snippet messageAction()}
	<SendMessage {machine} />
{/snippet}

<div class="sections">
	<LowDiskNotice
		drives={machine.lowDisk}
		storageOf={hasPermission(data.grants, 'files') ? machine.id : undefined}
	/>
	<Panel heading="Health" actions={undefined} tone="normal" padding="normal">
		{#if status.kind === 'online' && machine.live.kind === 'known'}
			<div class="meters">
				<UsageBar
					label="CPU"
					percent={Math.round(machine.live.cpuPercent)}
					detail="{Math.round(machine.live.cpuPercent)}%"
				/>
				{#if machine.inventory.kind === 'known'}
					<UsageBar
						label="Memory"
						percent={percentOf(machine.live.memoryUsedBytes, machine.inventory.memoryTotalBytes)}
						detail="{formatBytes(machine.live.memoryUsedBytes)} of {formatBytes(
							machine.inventory.memoryTotalBytes
						)}"
					/>
				{/if}
			</div>
		{:else}
			<p class="muted">Live figures show when the machine is online.</p>
		{/if}
	</Panel>

	<Panel heading="Disks" actions={undefined} tone="normal" padding="normal">
		{#if machine.inventory.kind === 'known'}
			<div class="meters">
				{#each machine.inventory.disks as disk (disk.mount)}
					<UsageBar
						label={disk.mount}
						percent={percentOf(disk.usedBytes, disk.sizeBytes)}
						detail="{formatBytes(disk.usedBytes)} of {formatBytes(disk.sizeBytes)}"
					/>
				{/each}
			</div>
		{:else}
			<p class="muted">Waiting for the first inventory.</p>
		{/if}
	</Panel>

	<div class="wide">
		<Panel
			heading="System"
			actions={canSendUserMessage(data.grants, machine.osFamily) ? messageAction : undefined}
			tone="normal"
			padding="normal"
		>
			<dl>
				{#each facts as fact (fact.label)}
					<div class="fact">
						<dt>{fact.label}</dt>
						<dd>{fact.value}</dd>
					</div>
				{/each}
			</dl>
		</Panel>
	</div>

	{#if hasPermission(data.grants, 'share-links')}
		<div class="wide">
			<ShareLinks machineId={machine.id} machineName={machine.name} />
		</div>
	{/if}

	<InventoryList
		heading="Graphics"
		label="Graphics cards"
		rows={graphics}
		none="No graphics cards reported."
	/>

	<InventoryList
		heading="Network"
		label="Network adapters"
		rows={network}
		none="No network adapters reported."
	/>

	<div class="wide">
		<DisplayCard
			report={machine.inventory.kind === 'known' ? machine.inventory.display : undefined}
		/>
	</div>
</div>

<style>
	.sections {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap-section);
	}

	@media (min-width: 900px) {
		.sections {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.wide {
			grid-column: 1 / -1;
		}
	}

	.meters {
		display: grid;
		gap: var(--space-4);
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: var(--space-4);
		margin: 0;
	}

	dt {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}
</style>
