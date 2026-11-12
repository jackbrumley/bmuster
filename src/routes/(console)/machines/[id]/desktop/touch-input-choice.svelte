<script lang="ts">
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import type { TouchMode } from './touch-gestures.ts';
	import { TOUCH_MODES } from './touch-input.ts';

	/**
	 * How a finger drives the remote pointer (SPEC-DESKTOP-FLOATING FA20): the
	 * one control for it, under the screen on the page and in the full-screen
	 * sheet's Session tab, so both use the same label, names and order.
	 */
	let { value, onchange }: { value: TouchMode; onchange: (mode: TouchMode) => void } = $props();
</script>

<SegmentedControl
	label="Touch input"
	options={TOUCH_MODES}
	bind:value={
		() => value,
		(next: TouchMode | null) => {
			if (next !== null) onchange(next);
		}
	}
/>
