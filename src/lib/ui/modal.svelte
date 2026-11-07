<script lang="ts">
	import type { Snippet } from 'svelte';
	import { IconX } from '@tabler/icons-svelte-runes';

	/**
	 * A modal for viewing or editing one record (AGENTS.md §12): a title, the
	 * body, and Save / Cancel in the footer. Escape and the close button call
	 * `onclose`; the parent decides whether it is open.
	 */
	let {
		open,
		title,
		onclose,
		children,
		footer
	}: {
		open: boolean;
		title: string;
		onclose: () => void;
		children: Snippet;
		footer: Snippet;
	} = $props();

	let dialog = $state<HTMLDialogElement | undefined>(undefined);
	const titleId = $props.id();

	$effect(() => {
		if (dialog === undefined) {
			return;
		}
		if (open && !dialog.open) {
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	class="modal"
	aria-labelledby={titleId}
	oncancel={(event) => {
		event.preventDefault();
		onclose();
	}}
>
	{#if open}
		<header class="head">
			<h2 id={titleId}>{title}</h2>
			<button
				data-raw-button="icon"
				type="button"
				class="close"
				aria-label="Close"
				onclick={onclose}
			>
				<IconX size={20} />
			</button>
		</header>
		<div class="body">
			{@render children()}
		</div>
		<footer class="foot">
			{@render footer()}
		</footer>
	{/if}
</dialog>

<style>
	.modal {
		width: min(32rem, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		background: var(--surface-overlay);
		color: var(--text);
		box-shadow: var(--shadow-popover);
	}

	.modal::backdrop {
		background: var(--shadow-tint);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-4) 0 var(--space-6);
	}

	h2 {
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-muted);
	}

	.body {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-6);
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-6) var(--space-6);
		border-top: 1px solid var(--border);
	}
</style>
