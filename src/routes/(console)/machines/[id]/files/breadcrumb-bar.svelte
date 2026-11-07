<script lang="ts">
	import { IconChevronRight, IconRefresh } from '@tabler/icons-svelte-runes';
	import type { Crumb } from '#lib/domain/files/files.ts';

	/**
	 * Where the Files tab is (SPEC-FILES F9): "This PC › C: › Users", one
	 * tap target per part, scrolling sideways on a phone with the last part
	 * in view.
	 */
	let {
		crumbs,
		onpick,
		onrefresh
	}: {
		crumbs: readonly Crumb[];
		onpick: (target: Crumb['target']) => void;
		onrefresh: () => void;
	} = $props();

	let strip = $state<HTMLElement>();

	$effect(() => {
		if (strip !== undefined && crumbs.length > 0) {
			strip.scrollLeft = strip.scrollWidth;
		}
	});
</script>

<div class="bar">
	<nav class="crumbs" aria-label="Folder path" bind:this={strip}>
		<ol>
			{#each crumbs as crumb, index (index)}
				<li>
					{#if index > 0}
						<IconChevronRight size={14} aria-hidden="true" />
					{/if}
					<button
						data-raw-button="chip"
						type="button"
						class="crumb"
						aria-current={index === crumbs.length - 1 ? 'location' : undefined}
						onclick={() => {
							onpick(crumb.target);
						}}>{crumb.label}</button
					>
				</li>
			{/each}
		</ol>
	</nav>
	<button
		data-raw-button="icon"
		type="button"
		class="refresh"
		aria-label="Refresh"
		onclick={onrefresh}
	>
		<IconRefresh size={18} />
	</button>
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.crumbs {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	ol {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
		white-space: nowrap;
		color: var(--muted);
	}

	li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}

	.crumb {
		min-height: 40px;
		padding: 0 var(--space-3);
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-soft);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.crumb:hover {
		background: var(--surface-muted);
	}

	.crumb[aria-current='location'] {
		background: var(--brand-tint);
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}

	.refresh {
		display: inline-flex;
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
</style>
