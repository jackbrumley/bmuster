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

	/** How far the row is scrolled and how much shows, as fractions of its full width. */
	let view = $state({ start: 0, shown: 1 });

	function measure(): void {
		if (nav === undefined || nav.scrollWidth <= 0) return;
		view = { start: nav.scrollLeft / nav.scrollWidth, shown: nav.clientWidth / nav.scrollWidth };
	}

	// The thin bar under a row that does not fit says it scrolls (phones).
	$effect(() => {
		const element = nav;
		if (element === undefined) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	});

	const scrolls = $derived(view.shown < 0.999);

	// On a phone the row scrolls; keep the current tab in view, also when the
	// page opens straight on a tab at the far end.
	$effect(() => {
		const path = current;
		const link = nav?.querySelector(`a[href="${CSS.escape(path)}"]`);
		link?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
</script>

<div class="tab-nav">
	<nav
		class="tabs"
		class:more-before={scrolls && view.start > 0.001}
		class:more-after={scrolls && view.start + view.shown < 0.999}
		aria-label={label}
		bind:this={nav}
		onscroll={measure}
	>
		{#each tabs as tab (tab.href)}
			<a class="tab" href={tab.href} aria-current={current === tab.href ? 'page' : undefined}>
				<tab.icon size={18} stroke={1.75} />
				{tab.label}
			</a>
		{/each}
	</nav>
	{#if scrolls}
		<div class="scroll-track" aria-hidden="true">
			<div
				class="scroll-thumb"
				style:left="{view.start * 100}%"
				style:width="{view.shown * 100}%"
			></div>
		</div>
	{/if}
</div>

<style>
	.tab-nav {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	/* Tabs past the edge fade out, so a cut-off row reads as more to scroll to. */
	.tabs.more-after {
		mask-image: linear-gradient(to right, var(--mask-solid) calc(100% - 32px), transparent);
	}

	.tabs.more-before {
		mask-image: linear-gradient(to left, var(--mask-solid) calc(100% - 32px), transparent);
	}

	.tabs.more-before.more-after {
		mask-image: linear-gradient(
			to right,
			transparent,
			var(--mask-solid) 32px,
			var(--mask-solid) calc(100% - 32px),
			transparent
		);
	}

	.scroll-track {
		position: relative;
		height: 3px;
		margin: 0 var(--space-4);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
	}

	.scroll-thumb {
		position: absolute;
		top: 0;
		bottom: 0;
		border-radius: var(--radius-pill);
		background: var(--muted);
	}

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
