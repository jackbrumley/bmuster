<script lang="ts">
	import { statusLabel, type MachineStatus } from '#lib/domain/machines/machine.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Online, Reconnecting (amber, the moment its live socket closed) or
	 * Offline (SPEC-PRESENCE P9). `since: 'shown'` adds how long ago an offline
	 * machine went offline; tables that show it in a column of their own hide it.
	 */
	let { status, now, since }: { status: MachineStatus; now: number; since: 'shown' | 'hidden' } =
		$props();

	const label = $derived(
		status.kind === 'offline' && since === 'shown'
			? `${statusLabel(status)} · ${formatRelative(status.sinceIso, now)}`
			: statusLabel(status)
	);
</script>

<span class="badge {status.kind}">
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

	.reconnecting {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.reconnecting .dot {
		background: var(--warning);
	}
</style>
