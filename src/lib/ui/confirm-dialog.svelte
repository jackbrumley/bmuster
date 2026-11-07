<script lang="ts">
	import Button from './button.svelte';
	import { confirmation } from './confirm-action.svelte.ts';

	/** Shows the question `confirmAction()` asks. Mounted once, in the console frame. */
	let dialog = $state<HTMLDialogElement | undefined>(undefined);

	const asking = $derived(
		confirmation.current.kind === 'asking' ? confirmation.current : undefined
	);

	$effect(() => {
		if (dialog === undefined) {
			return;
		}
		if (asking !== undefined && !dialog.open) {
			dialog.showModal();
		} else if (asking === undefined && dialog.open) {
			dialog.close();
		}
	});

	function answer(yes: boolean): void {
		asking?.answer(yes);
	}
</script>

<dialog
	bind:this={dialog}
	class="confirm"
	aria-labelledby="confirm-title"
	oncancel={(event) => {
		event.preventDefault();
		answer(false);
	}}
>
	{#if asking !== undefined}
		<h2 id="confirm-title">{asking.options.title}</h2>
		<p>{asking.options.message}</p>
		<div class="actions">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					answer(false);
				}}
			>
				Cancel
			</Button>
			<Button
				variant="danger"
				size="compact"
				type="button"
				onclick={() => {
					answer(true);
				}}
			>
				{asking.options.confirmLabel}
			</Button>
		</div>
	{/if}
</dialog>

<style>
	.confirm {
		width: min(26rem, calc(100vw - 32px));
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		background: var(--surface-overlay);
		color: var(--text);
		box-shadow: var(--shadow-popover);
	}

	.confirm::backdrop {
		background: var(--shadow-tint);
	}

	h2 {
		margin-bottom: var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
	}

	p {
		margin-bottom: var(--space-6);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
