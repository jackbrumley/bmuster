<script lang="ts">
	import type { Release } from '#lib/domain/releases/changelog.ts';

	/**
	 * One release's notes: what changed, then what to test on real machines when the
	 * release lists any (the same section the GitHub release notes carry).
	 */
	let { release }: { release: Release } = $props();
</script>

<h2>BMuster {release.version}</h2>
<ul>
	{#each release.changes as change (change)}<li>{change}</li>{/each}
</ul>
{#if release.testing.kind === 'steps'}
	<h3>What to test on real machines</h3>
	<ul>
		{#each release.testing.steps as step (step)}<li>{step}</li>{/each}
	</ul>
{/if}

<style>
	h3 {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	li {
		overflow-wrap: anywhere;
	}
</style>
