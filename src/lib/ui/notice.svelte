<script lang="ts">
	import type { Snippet } from 'svelte';
	import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-svelte-runes';

	/**
	 * A tinted box for a state someone must notice and act on, inside a panel or above a page's
	 * content: an agent that cannot update itself, a paused roll-out. `warning` for something to
	 * fix, `danger` for something that failed, `info` for a plain heads-up.
	 */
	let {
		tone,
		title,
		children
	}: { tone: 'warning' | 'danger' | 'info'; title: string; children: Snippet | undefined } =
		$props();

	const Icon = $derived(tone === 'info' ? IconInfoCircle : IconAlertTriangle);
</script>

<div class="notice tone-{tone}" role={tone === 'info' ? 'status' : 'alert'}>
	<span class="icon"><Icon size={20} stroke={2} /></span>
	<div class="body">
		<p class="title">{title}</p>
		{#if children !== undefined}
			<div class="detail">{@render children()}</div>
		{/if}
	</div>
</div>

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-inner);
		border: 1px solid currentColor;
	}

	.tone-warning {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.tone-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.tone-info {
		background: var(--brand-tint);
		color: var(--brand);
	}

	.icon {
		display: inline-flex;
		flex-shrink: 0;
		padding-top: var(--space-0-5);
	}

	.body {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.detail {
		display: grid;
		gap: var(--space-2);
		color: var(--text);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
