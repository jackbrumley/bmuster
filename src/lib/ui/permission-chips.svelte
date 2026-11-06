<script lang="ts">
	import { permissionLabel, type Permission } from '#lib/domain/access/access.ts';

	let { permissions }: { permissions: Permission[] } = $props();
</script>

<ul class="chips">
	{#each permissions as permission (permission)}
		<li class="chip">{permissionLabel(permission)}</li>
	{/each}
</ul>

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		padding: 2px var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--brand-tint);
		color: var(--brand);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}
</style>
