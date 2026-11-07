<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import type { IconDevices } from '@tabler/icons-svelte-runes';

	/**
	 * A row of tabs that are links (the machine's Overview, Terminal, Desktop…):
	 * a muted track with the current tab raised. It scrolls sideways on narrow
	 * phones instead of wrapping, so every tab sits in the same place on every
	 * page it is shown on.
	 */
	let {
		label,
		tabs,
		current
	}: {
		label: string;
		tabs: readonly { href: ResolvedPathname; label: string; icon: typeof IconDevices }[];
		/** The path being shown; the tab whose href matches is marked current. */
		current: string;
	} = $props();

	let nav = $state<HTMLElement | undefined>(undefined);

	// On a phone the row scrolls; keep the current tab in view, also when the
	// page opens straight on a tab at the far end.
	$effect(() => {
		const path = current;
		const link = nav?.querySelector(`a[href="${CSS.escape(path)}"]`);
		link?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
</script>

<nav class="tabs" aria-label={label} bind:this={nav}>
	{#each tabs as tab (tab.href)}
		<a class="tab" href={tab.href} aria-current={current === tab.href ? 'page' : undefined}>
			<tab.icon size={18} stroke={1.75} />
			{tab.label}
		</a>
	{/each}
</nav>

<style>
	.tabs {
		display: flex;
		gap: var(--space-1);
		padding: var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tab {
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-pill);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}

	.tab:hover {
		color: var(--text);
	}

	.tab[aria-current='page'] {
		background: var(--surface-elevated);
		color: var(--text);
		box-shadow: var(--shadow-card);
	}
</style>
