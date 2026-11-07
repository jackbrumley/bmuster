<script lang="ts">
	import type { MachineStatus } from '#lib/domain/machines/machine.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	let { status, now }: { status: MachineStatus; now: number } = $props();

	const label = $derived(
		status.kind === 'online' ? 'Online' : `Offline · ${formatRelative(status.lastSeenIso, now)}`
	);
</script>

<span class="badge" class:online={status.kind === 'online'}>
	<span class="dot"></span>
	{label}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-round);
		background: var(--offline);
	}

	.online {
		background: var(--success-bg);
		color: var(--success);
	}

	.online .dot {
		background: var(--success);
		box-shadow: var(--shadow-status-online);
	}
</style>
