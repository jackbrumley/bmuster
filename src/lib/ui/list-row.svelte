<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import type { Snippet } from 'svelte';

	/**
	 * One row of a ListCard: the same padding, height, gap and hover on every
	 * list. A row opens something (`button`), goes somewhere (`link`) or only
	 * shows something (`static`). The content decides its own inner layout;
	 * give a single wrapping element `flex: 1; min-width: 0` to fill the row.
	 */
	let {
		action,
		align,
		dimmed,
		children
	}: {
		action:
			| { kind: 'button'; onclick: () => void }
			| { kind: 'link'; href: ResolvedPathname }
			| { kind: 'static' };
		/** `start` for rows whose content wraps to several lines. */
		align: 'center' | 'start';
		/** A row for something switched off (a disabled user). */
		dimmed: boolean;
		children: Snippet;
	} = $props();
</script>

{#if action.kind === 'button'}
	<button
		data-raw-button="list-row"
		type="button"
		class="row interactive {align}"
		class:dimmed
		onclick={action.onclick}
	>
		{@render children()}
	</button>
{:else if action.kind === 'link'}
	<a class="row interactive {align}" class:dimmed href={action.href}>
		{@render children()}
	</a>
{:else}
	<div class="row {align}" class:dimmed>
		{@render children()}
	</div>
{/if}

<style>
	.row {
		display: flex;
		gap: var(--space-3);
		width: 100%;
		min-height: 56px;
		padding: var(--space-4);
		border: none;
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
	}

	.center {
		align-items: center;
	}

	.start {
		align-items: flex-start;
	}

	.interactive {
		cursor: pointer;
	}

	.interactive:hover {
		background: var(--surface-muted);
	}

	.dimmed {
		opacity: 0.6;
	}
</style>
