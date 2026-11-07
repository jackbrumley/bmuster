<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One round icon button of the desktop's tools, in the page's bar and in
	 * the full-screen bar. `pressed` is undefined for a plain action and a
	 * boolean for a toggle (picture settings).
	 */
	let {
		label,
		pressed,
		disabled,
		onclick,
		children
	}: {
		label: string;
		pressed: boolean | undefined;
		disabled: boolean;
		onclick: () => void;
		children: Snippet;
	} = $props();
</script>

<button
	data-raw-button="icon"
	type="button"
	class="tool"
	aria-label={label}
	title={label}
	aria-pressed={pressed}
	{disabled}
	{onclick}>{@render children()}</button
>

<style>
	.tool {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		cursor: pointer;
	}

	.tool:hover:not(:disabled) {
		background: var(--surface-muted);
	}

	.tool:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.tool[aria-pressed='true'] {
		border-color: var(--brand);
		color: var(--brand);
	}
</style>
