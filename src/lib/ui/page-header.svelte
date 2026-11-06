<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Title and one-line summary at the top of a console page, with optional actions on the right. */
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
		margin-bottom: var(--space-4);
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
		gap: var(--space-2);
	}
</style>
