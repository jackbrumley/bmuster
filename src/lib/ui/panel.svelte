<script lang="ts">
	import type { Snippet } from 'svelte';
	import SectionHeading from './section-heading.svelte';

	/**
	 * The one card look of the console (AGENTS.md §4): border, card radius,
	 * raised surface, and a heading row with optional actions. Pages never
	 * draw their own cards (hygiene rule `route-card-look-forbidden`).
	 *
	 * - `padding: 'normal'` stacks the content with the standard gap;
	 *   `'none'` lets rows run edge to edge (ListCard, the machine cards), and
	 *   the heading row gets a divider under it. The first content row takes
	 *   any spare height (a machine card's link above its action buttons).
	 * - `tone: 'danger'` is for the one panel that destroys something.
	 */
	let {
		heading,
		actions,
		tone,
		padding,
		children
	}: {
		heading: string | undefined;
		actions: Snippet | undefined;
		tone: 'normal' | 'danger';
		padding: 'normal' | 'none';
		children: Snippet;
	} = $props();

	const uid = $props.id();
	const headingId = `${uid}-heading`;
</script>

<svelte:element
	this={heading === undefined ? 'div' : 'section'}
	class="panel tone-{tone} pad-{padding}"
	class:has-head={heading !== undefined || actions !== undefined}
	aria-labelledby={heading === undefined ? undefined : headingId}
>
	{#if heading !== undefined || actions !== undefined}
		<div class="head">
			{#if heading !== undefined}
				<SectionHeading id={headingId} text={heading} {tone} />
			{/if}
			{#if actions !== undefined}
				<div class="actions">{@render actions()}</div>
			{/if}
		</div>
	{/if}
	{@render children()}
</svelte:element>

<style>
	.panel {
		display: grid;
		/* minmax(0, …): long values (commands, addresses) wrap or scroll inside instead of widening the card. */
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--space-4);
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	.pad-normal {
		padding: var(--panel-padding);
	}

	/*
	 * The first content row takes any spare height, so when cards in a row
	 * are stretched to the same height their footers still line up.
	 */
	.pad-none {
		grid-template-rows: 1fr;
		gap: 0;
		overflow: hidden;
	}

	.pad-none.has-head {
		grid-template-rows: auto 1fr;
	}

	.tone-danger {
		border-color: var(--danger);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
	}

	.pad-none > .head {
		padding: var(--space-3) var(--panel-padding);
		border-bottom: 1px solid var(--border);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
