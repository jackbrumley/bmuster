<script lang="ts">
	import { IconDatabase } from '@tabler/icons-svelte-runes';
	import { scanLine, type DriveSummary } from '#lib/domain/storage/storage.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import UsageBar from '#lib/ui/usage-bar.svelte';
	import { formatBytes, percentOf } from '#lib/utils/format.ts';

	/**
	 * Each scanned drive (SPEC-STORAGE 7): how full it is and how fresh its
	 * scan is. Tapping one opens its biggest folders; `onopen: undefined` is
	 * the read-only list from the last report, while the machine is offline.
	 */
	let {
		drives,
		now,
		onopen
	}: {
		drives: readonly DriveSummary[];
		now: number;
		onopen: ((mount: string) => void) | undefined;
	} = $props();
</script>

{#snippet driveRow(drive: DriveSummary)}
	<ListRow
		action={onopen === undefined
			? { kind: 'static' }
			: {
					kind: 'button',
					onclick: () => {
						onopen(drive.mount);
					}
				}}
		align="center"
		dimmed={false}
	>
		<span class="icon"><IconDatabase size={22} /></span>
		<span class="drive">
			<UsageBar
				label="Used on {drive.mount}"
				percent={percentOf(drive.sizeBytes - drive.freeBytes, drive.sizeBytes)}
				detail="{formatBytes(drive.freeBytes)} free of {formatBytes(drive.sizeBytes)}"
			/>
			<span class="scan">{scanLine(drive, now)}</span>
		</span>
	</ListRow>
{/snippet}

<ListCard
	heading="Drives"
	actions={undefined}
	label="Drives"
	items={drives}
	key={(drive: DriveSummary) => drive.mount}
	row={driveRow}
	empty="The machine reported no local drives to scan."
/>

<style>
	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.drive {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: var(--space-1);
	}

	.scan {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
