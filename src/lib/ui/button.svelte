<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The standard action button (AGENTS.md §4, §12): a pill, at least 40px
	 * tall. `primary` is the page's main action in the brand colour;
	 * `secondary` is a quieter outlined action; `danger` confirms something
	 * destructive. `large` fills its row at 48px, for the main action of a form.
	 * A `button` with no `onclick` has nothing to do yet, so it is disabled
	 * (Approve on an AI assistant's request, SPEC-MCP M25); a `submit` button
	 * submits its form.
	 */
	let {
		variant,
		size,
		type,
		onclick,
		children
	}: {
		variant: 'primary' | 'secondary' | 'danger';
		size: 'compact' | 'large';
		type: 'button' | 'submit';
		onclick: (() => void) | undefined;
		children: Snippet;
	} = $props();
</script>

<button
	{type}
	class="button {variant} {size}"
	{onclick}
	disabled={type === 'button' && onclick === undefined}
>
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

	.danger {
		border: none;
		background: var(--danger);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
	}

	.danger:hover {
		opacity: 0.9;
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

	.button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.large {
		width: 100%;
		min-height: 48px;
		font-size: var(--text-base);
	}
</style>
