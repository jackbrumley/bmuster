<script lang="ts">
	import { IconAlertTriangle, IconCloudDownload, IconPin } from '@tabler/icons-svelte-runes';
	import RadarSpinner from './radar-spinner.svelte';
	import { updateBadge, type MachineUpdateState } from '#lib/domain/machines/agent-updates.ts';

	/**
	 * The agent's update state as a small pill (SPEC-AGENT-UPDATES): Update available, Updating,
	 * Rolled back, Update refused or Pinned. Nothing at all while the agent is up to date.
	 */
	let { state }: { state: MachineUpdateState } = $props();

	const badge = $derived(updateBadge(state));
	const Icon = $derived(
		state.kind === 'pinned'
			? IconPin
			: state.kind === 'rolled-back' || state.kind === 'refused'
				? IconAlertTriangle
				: IconCloudDownload
	);
</script>

{#if badge.kind === 'shown'}
	<span class="badge tone-{badge.tone}" data-update-state={state.kind}>
		{#if state.kind === 'updating'}
			<RadarSpinner size="tiny" />
		{:else}
			<Icon size={14} stroke={2} />
		{/if}
		{badge.label}
	</span>
{/if}

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
	}

	.tone-warning {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.tone-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.tone-brand {
		background: var(--brand-tint);
		color: var(--brand);
	}

	.tone-muted {
		background: var(--surface-muted);
		color: var(--text-soft);
	}
</style>
