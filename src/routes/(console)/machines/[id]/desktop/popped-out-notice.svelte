<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';

	/**
	 * The tab while its session shows in the window it popped out
	 * (SPEC-DESKTOP-POPOUT 8): Bring it back focuses that window, or once it
	 * is closed takes the session back here; Close window closes it and
	 * takes the session back.
	 */
	let {
		closed,
		onbringback,
		onclose
	}: { closed: boolean; onbringback: () => void; onclose: () => void } = $props();
</script>

<Notice tone="info" title={closed ? 'The separate window was closed' : 'Open in a separate window'}>
	<p>
		{closed
			? 'The session is still running. Bring it back to keep going here.'
			: 'The session shows in its own window.'}
	</p>
	<div class="actions">
		<Button variant="primary" size="compact" type="button" onclick={onbringback}
			>Bring it back</Button
		>
		{#if !closed}
			<Button variant="secondary" size="compact" type="button" onclick={onclose}
				>Close window</Button
			>
		{/if}
	</div>
</Notice>

<style>
	p {
		margin: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
