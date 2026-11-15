<script lang="ts">
	import { IconDownload, IconFiles, IconX } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import type { FilesWaiting } from './session-chrome.svelte.ts';
	import ToolButton from './tool-button.svelte';

	/**
	 * Files copied on the machine are waiting (SPEC-DESKTOP 23.4, 4): a small
	 * pill in every view, "2 files copied on the machine · Download", that
	 * never blocks the screen. Put away hides it for this copy; Download stays
	 * on the bar and as a badge on the controls button.
	 */
	let { waiting, onputaway }: { waiting: FilesWaiting; onputaway: () => void } = $props();
</script>

<div class="waiting" role="status">
	<IconFiles size={18} aria-hidden="true" />
	<span class="text">{waiting.text}</span>
	<Button variant="primary" size="compact" type="button" onclick={waiting.download.run}
		><IconDownload size={18} /> Download</Button
	>
	<ToolButton label="Put away" pressed={undefined} disabled={false} onclick={onputaway}>
		<IconX size={18} />
	</ToolButton>
</div>

<style>
	.waiting {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		justify-self: center;
		max-width: 100%;
		padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
		color: var(--text);
		font-size: var(--text-sm);
	}

	.text {
		min-width: 0;
		overflow-wrap: anywhere;
	}
</style>
