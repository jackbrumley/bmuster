<script lang="ts">
	import {
		IconArrowDown,
		IconArrowLeft,
		IconArrowRight,
		IconArrowUp,
		IconKeyboard
	} from '@tabler/icons-svelte-runes';
	import type { InputMessage } from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import { characterKeys, chordMessages, keyBarFor, type BarKey, type Modifier } from './keys.ts';

	/**
	 * The phone's keys for the remote screen (SPEC-DESKTOP 5.3): Esc, Tab,
	 * Ctrl, Alt, the Windows key, arrows, and a button that opens the phone's
	 * own keyboard, whose characters go as `text`. Ctrl and Alt stay pressed
	 * for the next key. Pressing a key never takes focus from the typing
	 * area, so the phone's keyboard stays open. Ctrl+Alt+Del and other
	 * combinations are on the Keys menu (SPEC-DESKTOP-KEYS).
	 */
	let { osFamily, send }: { osFamily: OsFamily; send: (message: InputMessage) => void } = $props();

	const keys = $derived(keyBarFor(osFamily));

	let ctrl = $state(false);
	let alt = $state(false);
	let typing = $state<HTMLElement>();
	let open = $state(false);

	const ICONS = {
		up: IconArrowUp,
		down: IconArrowDown,
		left: IconArrowLeft,
		right: IconArrowRight
	} as const;

	/** Presses `code` with any latched Ctrl and Alt around it, then lets them go. */
	function tap(code: string, key: string): void {
		const modifiers: Modifier[] = [
			...(ctrl ? ['ctrl' as const] : []),
			...(alt ? ['alt' as const] : [])
		];
		for (const message of chordMessages({ modifiers, key: { code, key } })) {
			send(message);
		}
		ctrl = false;
		alt = false;
	}

	function press(key: BarKey): void {
		switch (key.kind) {
			case 'ctrl':
				ctrl = !ctrl;
				return;
			case 'alt':
				alt = !alt;
				return;
			case 'key':
				tap(key.code, key.key);
				return;
		}
	}

	function toggleKeyboard(): void {
		if (open) {
			typing?.blur();
			return;
		}
		typing?.focus();
	}

	/** The phone keyboard's input: characters go as text, except with Ctrl or Alt latched. */
	function onBeforeInput(event: InputEvent): void {
		event.preventDefault();
		switch (event.inputType) {
			case 'insertText':
			case 'insertReplacementText': {
				const text = event.data ?? '';
				const keys = ctrl || alt ? characterKeys(text) : undefined;
				if (keys !== undefined) {
					tap(keys.code, keys.key);
				} else if (text !== '') {
					send({ type: 'text', text });
				}
				return;
			}
			case 'insertParagraph':
			case 'insertLineBreak':
				tap('Enter', 'Enter');
				return;
			case 'deleteContentBackward':
				tap('Backspace', 'Backspace');
				return;
			case 'deleteContentForward':
				tap('Delete', 'Delete');
				return;
			default:
				return;
		}
	}
</script>

<div class="keys" role="toolbar" aria-label="Keys">
	<button
		data-raw-button="key"
		type="button"
		class="key"
		aria-label={open ? 'Hide the keyboard' : 'Show the keyboard'}
		aria-pressed={open}
		onpointerdown={(event) => {
			event.preventDefault();
		}}
		onclick={toggleKeyboard}><IconKeyboard size={18} /></button
	>
	{#each keys as key (key.id)}
		<button
			data-raw-button="key"
			type="button"
			class="key"
			aria-label={key.label}
			aria-pressed={key.kind === 'ctrl' ? ctrl : key.kind === 'alt' ? alt : undefined}
			onpointerdown={(event) => {
				event.preventDefault();
			}}
			onclick={() => {
				press(key);
			}}
		>
			{#if key.id === 'up' || key.id === 'down' || key.id === 'left' || key.id === 'right'}
				{@const Icon = ICONS[key.id]}
				<Icon size={18} />
			{:else}
				{key.text}
			{/if}
		</button>
	{/each}
	<div
		class="typing"
		bind:this={typing}
		contenteditable="true"
		role="textbox"
		tabindex="-1"
		aria-label="Type on the machine"
		autocapitalize="off"
		spellcheck="false"
		onbeforeinput={onBeforeInput}
		onfocus={() => (open = true)}
		onblur={() => (open = false)}
	></div>
</div>

<style>
	.keys {
		display: flex;
		gap: var(--space-2);
		overflow-x: auto;
		padding-bottom: var(--space-1);
		scrollbar-width: none;
	}

	.key {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		height: 40px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.key[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	/* Off screen but focusable, so the phone opens its keyboard for it. */
	.typing {
		position: absolute;
		left: -200vw;
		width: 1px;
		height: 1px;
		overflow: hidden;
		font-size: var(--text-base);
		opacity: 0;
	}
</style>
