<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconAlertTriangle, IconCloudDownload, IconPin } from '@tabler/icons-svelte-runes';
	import RadarSpinner from './radar-spinner.svelte';
	import {
		AGENT_UPDATE_SECTION,
		updateBadge,
		updateLinkLabel,
		type MachineUpdateState,
		type UpdateBadgeLink
	} from '#lib/domain/machines/agent-updates.ts';

	/**
	 * The agent's update state as a small pill (SPEC-AGENT-UPDATES): Update available, Updating,
	 * Rolled back, Update refused or Pinned. Nothing at all while the agent is up to date. For
	 * people who may update the agent it is a link to the machine's Agent update section (U15).
	 */
	let { state, link }: { state: MachineUpdateState; link: UpdateBadgeLink } = $props();

	const badge = $derived(updateBadge(state));
	const Icon = $derived(
		state.kind === 'pinned'
			? IconPin
			: state.kind === 'rolled-back' || state.kind === 'refused'
				? IconAlertTriangle
				: IconCloudDownload
	);
</script>

{#snippet content(label: string)}
	{#if state.kind === 'updating'}
		<RadarSpinner size="tiny" />
	{:else}
		<Icon size={14} stroke={2} />
	{/if}
	{label}
{/snippet}

{#if badge.kind === 'shown'}
	{#if link.kind === 'link'}
		<a
			class="badge linked tone-{badge.tone}"
			data-update-state={state.kind}
			href="{resolve('/(console)/machines/[id]/manage', {
				id: link.machineId
			})}#{AGENT_UPDATE_SECTION}"
			aria-label={updateLinkLabel(link.machineName, state)}
		>
			{@render content(badge.label)}
		</a>
	{:else}
		<span class="badge tone-{badge.tone}" data-update-state={state.kind}>
			{@render content(badge.label)}
		</span>
	{/if}
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

	/* A linked badge says so on hover, like the console's other text links. */
	.linked {
		position: relative;
	}

	.linked:hover {
		text-decoration: underline;
	}

	/* The pill is small; its tap area is the 40px a finger needs, centred on it. */
	.linked::after {
		content: '';
		position: absolute;
		top: calc(50% - 20px);
		right: 0;
		left: 0;
		height: 40px;
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
