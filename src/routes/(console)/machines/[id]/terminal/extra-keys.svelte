<script lang="ts">
	import { IconClipboard, IconCopy } from '@tabler/icons-svelte-runes';
	import { EXTRA_KEYS, type ExtraKeyId, type Modifiers } from './extra-keys.ts';

	/**
	 * The phone's missing keys (T5), under the terminal. Ctrl and Alt stay
	 * pressed for the next key. Pressing a key never takes focus from the
	 * terminal, so the phone's keyboard stays open.
	 */
	let {
		modifiers = $bindable(),
		onkey,
		onpaste,
		oncopy
	}: {
		modifiers: Modifiers;
		onkey: (key: Exclude<ExtraKeyId, 'ctrl' | 'alt'>) => void;
		onpaste: () => void;
		oncopy: () => void;
	} = $props();

	function press(id: ExtraKeyId): void {
		switch (id) {
			case 'ctrl':
				modifiers = { ...modifiers, ctrl: !modifiers.ctrl };
				return;
			case 'alt':
				modifiers = { ...modifiers, alt: !modifiers.alt };
				return;
			case 'esc':
			case 'tab':
			case 'up':
			case 'down':
			case 'left':
			case 'right':
			case 'pipe':
			case 'tilde':
			case 'slash':
			case 'dash':
				onkey(id);
				return;
		}
	}

	function latched(id: ExtraKeyId): boolean | undefined {
		switch (id) {
			case 'ctrl':
				return modifiers.ctrl;
			case 'alt':
				return modifiers.alt;
			case 'esc':
			case 'tab':
			case 'up':
			case 'down':
			case 'left':
			case 'right':
			case 'pipe':
			case 'tilde':
			case 'slash':
			case 'dash':
				return undefined;
		}
	}
</script>

<div class="keys" role="toolbar" aria-label="Extra keys">
	{#each EXTRA_KEYS as key (key.id)}
		<button
			data-raw-button="key"
			type="button"
			class="key"
			aria-label={key.name}
			aria-pressed={latched(key.id)}
			onpointerdown={(event) => {
				event.preventDefault();
			}}
			onclick={() => {
				press(key.id);
			}}>{key.label}</button
		>
	{/each}
	<button
		data-raw-button="icon"
		type="button"
		class="key"
		aria-label="Paste"
		onpointerdown={(event) => {
			event.preventDefault();
		}}
		onclick={onpaste}><IconClipboard size={18} /></button
	>
	<button
		data-raw-button="icon"
		type="button"
		class="key"
		aria-label="Copy the selection"
		onpointerdown={(event) => {
			event.preventDefault();
		}}
		onclick={oncopy}><IconCopy size={18} /></button
	>
</div>

<style>
	.keys {
		display: flex;
		gap: var(--space-2);
		overflow-x: auto;
		scrollbar-width: none;
		padding-bottom: var(--space-1);
	}

	.key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		min-width: 44px;
		height: 44px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		cursor: pointer;
		touch-action: manipulation;
	}

	.key[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	@media (min-width: 900px) {
		.keys {
			display: none;
		}
	}
</style>
