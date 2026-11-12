<script lang="ts">
	import { IconArrowsMaximize, IconPlugConnectedX } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';

	/**
	 * The phone page's only controls (SPEC-DESKTOP-POPOUT 3): back into full
	 * screen, where the sheet holds everything else, and Disconnect.
	 */
	let { onfullscreen, ondisconnect }: { onfullscreen: () => void; ondisconnect: () => void } =
		$props();
</script>

<div class="phone-bar">
	<Button variant="primary" size="compact" type="button" onclick={onfullscreen}
		><IconArrowsMaximize size={18} /> Full screen</Button
	>
	<Button variant="secondary" size="compact" type="button" onclick={ondisconnect}
		><IconPlugConnectedX size={18} /> Disconnect</Button
	>
</div>

<style>
	.phone-bar {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
