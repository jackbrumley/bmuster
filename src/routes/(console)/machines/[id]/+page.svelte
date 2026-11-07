<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import Panel from '#lib/ui/panel.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, formatRelative, percentOf } from '#lib/utils/format.ts';
	import { osLabel, signedInUserOf, type Gpu } from '#lib/domain/machines/machine.ts';
	import { inUseLabel } from '#lib/domain/sessions/session.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const user = $derived(signedInUserOf(machine));

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

	/** "NVIDIA GeForce RTX 4070 (12 GB)": the card, with its video memory when known (D8). */
	function gpuLabel(gpu: Gpu): string {
		if (gpu.memoryBytes.kind === 'unknown') {
			return gpu.name;
		}
		// Video memory comes in whole gigabytes on any card that has that much.
		const bytes = gpu.memoryBytes.bytes;
		const gigabytes = bytes / 1024 ** 3;
		return `${gpu.name} (${gigabytes >= 1 ? `${Math.round(gigabytes)} GB` : formatBytes(bytes)})`;
	}

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
				value:
					machine.status.kind === 'online'
						? 'Now'
						: formatRelative(machine.status.sinceIso, data.now)
			},
			{ label: 'Enrolled', value: formatRelative(machine.enrolledIso, data.now) }
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
				{
					label: 'Graphics',
					value:
						inventory.gpus.length === 0 ? 'None reported' : inventory.gpus.map(gpuLabel).join(', ')
				},
				{ label: 'Build', value: inventory.osBuild === '' ? 'Not reported' : inventory.osBuild },
				{
					label: 'Addresses',
					value: inventory.addresses.length === 0 ? 'None reported' : inventory.addresses.join(', ')
				}
			);
		}
		return list;
	});
</script>

<div class="sections">
	<Panel heading="Health" actions={undefined} tone="normal" padding="normal">
		{#if machine.status.kind === 'online' && machine.live.kind === 'known'}
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
		<Panel heading="System" actions={undefined} tone="normal" padding="normal">
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
