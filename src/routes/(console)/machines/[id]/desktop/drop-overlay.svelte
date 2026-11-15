<script lang="ts">
	import { IconUpload, IconBan } from '@tabler/icons-svelte-runes';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import type { Overlay } from './session-file-sender.svelte.ts';

	/**
	 * Over the whole stage while files are dragged over it
	 * (SPEC-SESSION-FILES 3.1): where they would go, or why they cannot.
	 * It covers the picture, so the drag never reaches the machine's pointer.
	 */
	let { overlay, machine }: { overlay: Overlay; machine: string } = $props();
</script>

{#if overlay.kind !== 'hidden'}
	<div class="drop" class:refused={overlay.kind === 'refused'} role="status" aria-live="polite">
		{#if overlay.kind === 'refused'}
			<IconBan size={40} />
			<p class="title">Files can't be sent</p>
			<p class="detail">{overlay.message}</p>
		{:else}
			<IconUpload size={40} />
			<p class="title">Drop to send to {machine}</p>
			{#if overlay.kind === 'ready'}
				<p class="detail">Saved to {overlay.user}'s {overlay.folderLabel}</p>
			{:else}
				<RadarSpinner size="small" />
			{/if}
		{/if}
	</div>
{/if}

<style>
	/* Over the picture and its veil, under the controls button. */
	.drop {
		position: absolute;
		inset: 0;
		z-index: 1;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-4);
		border: 2px dashed var(--brand);
		background: var(--surface-overlay);
		color: var(--brand);
		text-align: center;
	}

	.drop.refused {
		border-color: var(--border-strong);
		color: var(--muted);
	}

	.title {
		margin: 0;
		color: var(--text);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.detail {
		margin: 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
	}
</style>
