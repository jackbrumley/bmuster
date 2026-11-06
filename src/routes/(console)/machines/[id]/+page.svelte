<script lang="ts">
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, formatRelative, percentOf } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const machine = $derived(data.machine);

	const facts = $derived([
		{ label: 'Operating system', value: `${machine.os.name} ${machine.os.version}` },
		{
			label: 'Updates',
			value: machine.os.updatesPending === 0 ? 'Up to date' : `${machine.os.updatesPending} pending`
		},
		{
			label: 'Signed in',
			value: machine.signedInUser.kind === 'user' ? machine.signedInUser.name : 'Nobody'
		},
		{ label: 'Processor', value: `${machine.cpu.model} · ${machine.cpu.cores} cores` },
		{ label: 'Memory', value: formatBytes(machine.memory.totalBytes) },
		{
			label: 'Displays',
			value: machine.displays === 0 ? 'None (headless)' : `${machine.displays}`
		},
		{ label: 'IP address', value: machine.ipAddress },
		{ label: 'Agent', value: `v${machine.agentVersion}` },
		{
			label: machine.status.kind === 'online' ? 'Online for' : 'Last seen',
			value:
				machine.status.kind === 'online'
					? formatRelative(machine.status.sinceIso, data.now).replace(' ago', '')
					: formatRelative(machine.status.lastSeenIso, data.now)
		}
	]);
</script>

<div class="sections">
	<section class="panel">
		<h2>Health</h2>
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
			</div>
		{:else}
			<p class="muted">Live figures show when the machine is online.</p>
		{/if}
	</section>

	<section class="panel">
		<h2>Disks</h2>
		<div class="meters">
			{#each machine.disks as disk (disk.mount)}
				<UsageBar
					label={disk.mount}
					percent={percentOf(disk.usedBytes, disk.sizeBytes)}
					detail="{formatBytes(disk.usedBytes)} of {formatBytes(disk.sizeBytes)}"
				/>
			{/each}
		</div>
	</section>

	<section class="panel wide">
		<h2>System</h2>
		<dl>
			{#each facts as fact (fact.label)}
				<div class="fact">
					<dt>{fact.label}</dt>
					<dd>{fact.value}</dd>
				</div>
			{/each}
		</dl>
	</section>
</div>

<style>
	.sections {
		display: grid;
		gap: var(--space-4);
	}

	@media (min-width: 900px) {
		.sections {
			grid-template-columns: 1fr 1fr;
		}

		.wide {
			grid-column: 1 / -1;
		}
	}

	.panel {
		display: grid;
		gap: var(--space-4);
		align-content: start;
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
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
	}
</style>
