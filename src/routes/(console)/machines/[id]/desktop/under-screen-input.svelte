<script lang="ts">
	import type { InputMessage } from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import KeyBar from './key-bar.svelte';
	import type { TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';
	import { touchModeHelp } from './touch-input.ts';

	/**
	 * Under the screen in a control session: the key bar (narrow windows
	 * only) and the touch input choice with what it does.
	 */
	let {
		osFamily,
		send,
		touchMode,
		ontouchmode
	}: {
		osFamily: OsFamily;
		send: (message: InputMessage) => void;
		touchMode: TouchMode;
		ontouchmode: (mode: TouchMode) => void;
	} = $props();
</script>

<div class="phone-keys">
	<KeyBar {osFamily} {send} onkeyboard={undefined} />
</div>
<div class="touch-input">
	<TouchInputChoice value={touchMode} onchange={ontouchmode} />
	<p class="mode">{touchModeHelp(touchMode)}</p>
</div>

<style>
	.touch-input {
		display: grid;
		gap: var(--space-2);
	}

	.mode {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}

	@media (min-width: 900px) {
		.phone-keys {
			display: none;
		}
	}
</style>
