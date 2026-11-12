<script lang="ts">
	import LoadingVeil from './loading-veil.svelte';

	/**
	 * A wait that owns the whole screen (SPEC-LOADING): the console's sidebar,
	 * header and tab bar are covered, and only the LoadingVeil's card shows.
	 * For a wait where nothing else on screen can be used, such as the server
	 * restarting into a new version.
	 */
	let {
		title,
		detail
	}: {
		title: string;
		detail: string | undefined;
	} = $props();
</script>

<div class="screen">
	<LoadingVeil active={true} {title} {detail} children={undefined} />
</div>

<style>
	/* Above the shell's bars (z-index 10), below toasts (30). */
	.screen {
		position: fixed;
		top: var(--safe-top);
		right: var(--safe-right);
		bottom: var(--safe-bottom);
		left: var(--safe-left);
		z-index: 20;
		display: grid;
		align-content: center;
		padding: var(--page-gutter);
		background: var(--surface);
	}
</style>
