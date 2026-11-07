<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The standard action button (AGENTS.md §4, §12): a pill, at least 40px
	 * tall. `primary` is the page's main action in the brand colour;
	 * `secondary` is a quieter outlined action. `large` fills its row at 48px,
	 * for the main action of a form.
	 */
	let {
		variant,
		size,
		type,
		onclick,
		children
	}: {
		variant: 'primary' | 'secondary';
		size: 'compact' | 'large';
		type: 'button' | 'submit';
		onclick: (() => void) | undefined;
		children: Snippet;
	} = $props();
</script>

<button {type} class="button {variant} {size}" {onclick}>
	{@render children()}
</button>

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		flex-shrink: 0;
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-pill);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.primary {
		border: none;
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
	}

	.primary:hover {
		background: var(--brand-hover);
	}

	.secondary {
		border: 1px solid var(--border);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-weight: var(--weight-medium);
	}

	.secondary:hover {
		background: var(--surface-muted);
	}

	.large {
		width: 100%;
		min-height: 48px;
		font-size: var(--text-base);
	}
</style>
