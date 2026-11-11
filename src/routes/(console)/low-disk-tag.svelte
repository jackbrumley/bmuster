<script lang="ts">
	import { IconAlertTriangle } from '@tabler/icons-svelte-runes';
	import { lowDiskText, type LowDisk } from '#lib/domain/storage/storage.ts';
	import { formatBytes } from '#lib/utils/format.ts';

	/**
	 * "Low disk: C:\ 94 %" on the Machines list (SPEC-STORAGE 12): every drive at 90 % used or
	 * more, with each one's free space in the title.
	 */
	let { drives }: { drives: readonly LowDisk[] } = $props();

	const title = $derived(
		drives
			.map(
				(drive) => `${drive.mount} is ${drive.percent} % full, ${formatBytes(drive.freeBytes)} free`
			)
			.join('\n')
	);
</script>

<span class="low-disk" {title}>
	<IconAlertTriangle size={14} stroke={2} />
	Low disk: {lowDiskText(drives)}
</span>

<style>
	.low-disk {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--warning-bg);
		color: var(--warning);
		font-size: var(--text-xs);
	}
</style>
