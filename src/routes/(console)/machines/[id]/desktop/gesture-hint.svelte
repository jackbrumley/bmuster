<script lang="ts">
	import {
		IconArrowsMove,
		IconHandClick,
		IconHandFinger,
		IconHandGrab,
		IconZoomIn
	} from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';

	/**
	 * The first-time touch gestures hint (SPEC-DESKTOP-FLOATING, option A,
	 * 8): what a finger does on the remote screen. `ondismiss` hides it and
	 * remembers that.
	 */
	let { ondismiss }: { ondismiss: () => void } = $props();

	const GESTURES = [
		{ id: 'tap', icon: IconHandFinger, gesture: 'Tap', meaning: 'click' },
		{ id: 'double', icon: IconHandFinger, gesture: 'Double-tap', meaning: 'double-click' },
		{ id: 'drag', icon: IconHandGrab, gesture: 'Double-tap and hold', meaning: 'drag' },
		{ id: 'long', icon: IconHandClick, gesture: 'Long press', meaning: 'right click' },
		{ id: 'pinch', icon: IconZoomIn, gesture: 'Pinch', meaning: 'zoom' },
		{
			id: 'two',
			icon: IconArrowsMove,
			gesture: 'Two fingers',
			meaning: 'scroll, or move around when zoomed'
		}
	] as const;
</script>

<Panel heading="Touch gestures" actions={undefined} tone="normal" padding="normal">
	<ul class="gestures">
		{#each GESTURES as item (item.id)}
			<li>
				<item.icon size={18} aria-hidden="true" />
				<span><strong>{item.gesture}</strong>: {item.meaning}</span>
			</li>
		{/each}
	</ul>
	<div>
		<Button variant="secondary" size="compact" type="button" onclick={ondismiss}>Got it</Button>
	</div>
</Panel>

<style>
	.gestures {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	strong {
		color: var(--text);
		font-weight: var(--weight-semibold);
	}
</style>
