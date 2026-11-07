<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconDevices } from '@tabler/icons-svelte-runes';

	/**
	 * A page or tab with nothing to show yet: offline machines, no permission,
	 * no machines. Centred icon, one line in full colour, one muted line, and
	 * an optional link or button underneath.
	 */
	let {
		icon,
		title,
		detail,
		children
	}: {
		icon: typeof IconDevices | undefined;
		title: string;
		detail: string | undefined;
		children: Snippet | undefined;
	} = $props();
</script>

<div class="empty-state">
	{#if icon !== undefined}
		{@const Icon = icon}
		<Icon size={32} stroke={1.75} />
	{/if}
	<p class="title">{title}</p>
	{#if detail !== undefined}
		<p class="detail">{detail}</p>
	{/if}
	{#if children !== undefined}
		{@render children()}
	{/if}
</div>

<style>
	.empty-state {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-12) var(--space-4);
		color: var(--muted);
		text-align: center;
	}

	.title {
		color: var(--text);
		font-weight: var(--weight-semibold);
	}

	.detail {
		max-width: 32rem;
		font-size: var(--text-sm);
	}
</style>
