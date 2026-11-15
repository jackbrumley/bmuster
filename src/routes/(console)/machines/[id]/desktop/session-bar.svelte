<script lang="ts">
	import { IconArrowsMaximize, IconWindowMaximize } from '@tabler/icons-svelte-runes';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import type { SessionChrome } from './session-chrome.svelte.ts';
	import SessionTools from './session-tools.svelte';
	import ToolButton from './tool-button.svelte';

	/**
	 * The bar above the screen in the page (SPEC-DESKTOP): the screen picker
	 * and the session's tools (`session-tools.svelte`, shared with the
	 * floating bar), then Full screen and, on the console's tab, Pop out.
	 */
	let {
		chrome,
		onfullscreen,
		onpopout
	}: {
		chrome: SessionChrome;
		onfullscreen: () => void;
		/** Undefined where the session cannot pop out (a share link). */
		onpopout: (() => void) | undefined;
	} = $props();
</script>

<div class="bar">
	{#if chrome.has('display')}
		<ChipGroup
			label="Display"
			options={chrome.displays}
			bind:value={
				() => chrome.display,
				(value: string | null) => {
					if (value !== null) chrome.selectDisplay(value);
				}
			}
		/>
	{/if}
	<div class="tools">
		<SessionTools {chrome} look="bar" after={() => undefined}>
			{#snippet frame()}
				{#if !chrome.choosing}
					<ToolButton
						label="Full screen"
						pressed={undefined}
						disabled={false}
						onclick={onfullscreen}
					>
						<IconArrowsMaximize size={20} />
					</ToolButton>
				{/if}
				{#if chrome.running && onpopout !== undefined}
					<ToolButton
						label="Pop out into a window"
						pressed={undefined}
						disabled={false}
						onclick={onpopout}
					>
						<IconWindowMaximize size={20} />
					</ToolButton>
				{/if}
			{/snippet}
		</SessionTools>
	</div>
</div>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-left: auto;
	}
</style>
