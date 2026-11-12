<script lang="ts">
	import type { Snippet } from 'svelte';
	import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
	import ToastHost from '#lib/ui/toast-host.svelte';

	/**
	 * Frame for a page that is a window of its own (SPEC-DESKTOP-POPOUT 14):
	 * the remote desktop popped out of the console. The whole viewport, the
	 * screen colour behind, padded by the safe-area insets, no chrome; it
	 * owns the shared confirmation dialog and the toasts like the console
	 * frame does.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="window">
	{@render children()}
	<ConfirmDialog />
	<ToastHost />
</div>

<style>
	.window {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		height: 100dvh;
		min-height: 100dvh;
		padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
		overflow: hidden;
		background: var(--screen-bg);
		color: var(--terminal-text);
	}
</style>
