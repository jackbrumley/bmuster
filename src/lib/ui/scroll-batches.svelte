<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';

	/**
	 * Renders a long list a batch at a time: the first `batchSize` items, then
	 * another batch each time the end of the list comes near the bottom of the
	 * screen. Filtering and sorting happen on the full `items` before they get
	 * here; only rendering is held back.
	 *
	 * A new `resetKey` (the search, filter or sort changed) starts again from
	 * one batch. New `items` with the same key (fresher data) keep how far the
	 * person has scrolled.
	 */
	let {
		items,
		batchSize,
		resetKey,
		children
	}: {
		items: readonly T[];
		batchSize: number;
		resetKey: string;
		children: Snippet<[readonly T[]]>;
	} = $props();

	/** How far the list has grown, for the key it grew under. */
	let grown = $state<{ key: string; limit: number }>({ key: '', limit: 0 });

	const limit = $derived(grown.key === resetKey ? Math.max(grown.limit, batchSize) : batchSize);
	const shown = $derived(items.length > limit ? items.slice(0, limit) : items);

	// Starts loading the next batch well before the end scrolls into view.
	const AHEAD = '0px 0px 1200px 0px';

	/**
	 * Watches the marker after the last item. The marker is remade after every
	 * batch (see the `{#key}` below), so a new observer reports at once when the
	 * end is still in reach on a tall screen.
	 */
	const watchEnd: Attachment<HTMLElement> = (element) => {
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					grown = { key: resetKey, limit: limit + batchSize };
				}
			},
			{ rootMargin: AHEAD }
		);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	};
</script>

{@render children(shown)}

{#if shown.length < items.length}
	{#key limit}
		<div class="end" data-testid="scroll-batches-end" {@attach watchEnd}></div>
	{/key}
{/if}

<style>
	.end {
		height: 1px;
	}
</style>
