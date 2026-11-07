<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from '#lib/ui/logo.svelte';

	/** Frame for pages outside the console (sign-in, setup): centred card, safe areas padded. */
	let { children }: { children: Snippet } = $props();
</script>

<div class="public">
	<div class="brand">
		<Logo size={48} />
		<span class="wordmark">BMuster</span>
	</div>
	<div class="card">
		{@render children()}
	</div>
</div>

<style>
	.public {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: var(--space-6);
		min-height: 100dvh;
		padding: calc(var(--space-6) + var(--safe-top)) calc(var(--space-4) + var(--safe-right))
			calc(var(--space-6) + var(--safe-bottom)) calc(var(--space-4) + var(--safe-left));
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.wordmark {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.card {
		width: 100%;
		max-width: 26rem;
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-popover);
	}
</style>
