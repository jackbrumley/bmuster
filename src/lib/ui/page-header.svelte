<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Title and one-line summary at the top of every top-level console page,
	 * with optional actions on the right. ShellFrame spaces it from what
	 * follows, so a page adds no margin of its own (hygiene rule
	 * `page-header-required`).
	 */
	let {
		title,
		summary,
		actions
	}: { title: string; summary: string; actions: Snippet | undefined } = $props();
</script>

<header class="page-header">
	<div>
		<h1>{title}</h1>
		<p>{summary}</p>
	</div>
	{#if actions !== undefined}
		<div class="actions">{@render actions()}</div>
	{/if}
</header>

<style>
	.page-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-3);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	p {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
