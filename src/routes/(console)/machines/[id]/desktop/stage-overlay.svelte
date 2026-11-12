<script lang="ts">
	import { screenLabel, type DesktopScreen } from '#lib/domain/desktop/screen.ts';
	import Button from '#lib/ui/button.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';

	/**
	 * Over the picture while there is nothing to see yet: the approval a
	 * Wayland screen asks for, a screen that cannot be shown, or the veil
	 * while connecting. Shared by the desktop tab and its pop-out window.
	 */
	let {
		screen,
		waiting,
		onapprove
	}: {
		/** What the machine's screen shows, while a session runs. */
		screen: DesktopScreen | undefined;
		/** What the veil says while no picture has come yet. */
		waiting: string | undefined;
		onapprove: () => void;
	} = $props();
</script>

{#if screen?.kind === 'approval'}
	<div class="waiting">
		<p>{screenLabel(screen)}</p>
		{#if screen.phase !== 'pending'}
			<Button type="button" variant="primary" size="compact" onclick={onapprove}
				>Ask for approval</Button
			>
		{/if}
	</div>
{:else if screen?.kind === 'unavailable'}
	<p class="waiting unavailable">{screenLabel(screen)}</p>
{:else if waiting !== undefined}
	<div class="connecting">
		<LoadingVeil active={true} title={waiting} detail={undefined} children={undefined} />
	</div>
{/if}

<style>
	.waiting {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--terminal-text);
		font-size: var(--text-sm);
	}

	/* Its own layer, so the gestures hint and the controls button stay over the veil. */
	.connecting {
		position: absolute;
		inset: 0;
		z-index: 0;
		display: grid;
	}

	.waiting.unavailable {
		padding: var(--space-4);
		background: var(--screen-bg);
		text-align: center;
	}
</style>
