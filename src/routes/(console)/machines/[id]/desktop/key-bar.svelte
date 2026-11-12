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
	import {
		characterKeys,
		chordMessages,
		keyBarFor,
		textParts,
		type BarKey,
		type Modifier
	} from './keys.ts';

	/**
	 * The phone's keys for the remote screen (SPEC-DESKTOP 5.3): Esc, Tab,
	 * Ctrl, Alt, the Windows key, arrows, and a button that opens the phone's
	 * own keyboard, whose characters go as `text`, in a grid that wraps so
	 * every key is in sight. Ctrl and Alt stay pressed
	 * for the next key. Pressing a key never takes focus from the typing
	 * area, so the phone's keyboard stays open. Ctrl+Alt+Del and other
	 * combinations are on the Keys menu (SPEC-DESKTOP-KEYS). `onkeyboard`
	 * hears when the phone's keyboard opens and closes, so the full-screen
	 * sheet can fold around it (SPEC-DESKTOP-FLOATING). A paste from the
	 * phone's keyboard (its clipboard suggestion, or long-press Paste) is not
	 * typed: it goes to `onpaste`, which puts it on the machine's clipboard
	 * (SPEC-DESKTOP 21.11). Words a keyboard composes are typed when the
	 * composition ends.
	 */
	let {
		osFamily,
		send,
		onkeyboard,
		onpaste
	}: {
		osFamily: OsFamily;
		send: (message: InputMessage) => void;
		onkeyboard: ((open: boolean) => void) | undefined;
		onpaste: (text: string) => void;
	} = $props();

	const keys = $derived(keyBarFor(osFamily));

	let ctrl = $state(false);
	let alt = $state(false);
	let typing = $state<HTMLElement>();
	let open = $state(false);
	/** What a keyboard composes in the box until the word is done; emptied after. */
	let typed = $state('');

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

	/** Typed text: as `text` messages, or as a key with Ctrl or Alt latched. */
	function typeText(text: string): void {
		const keys = ctrl || alt ? characterKeys(text) : undefined;
		if (keys !== undefined) {
			tap(keys.code, keys.key);
			return;
		}
		for (const part of textParts(text)) {
			send({ type: 'text', text: part });
		}
	}

	/** A composed word: typed once the keyboard finishes it, then the box is emptied. */
	function onCompositionEnd(event: CompositionEvent): void {
		typeText(event.data);
		typed = '';
	}

	/** The phone keyboard's input: characters go as text, except with Ctrl or Alt latched. */
	function onBeforeInput(event: InputEvent): void {
		// A composition in progress cannot be cancelled; its word is typed at compositionend.
		if (event.inputType === 'insertCompositionText') {
			return;
		}
		event.preventDefault();
		switch (event.inputType) {
			case 'insertText':
			case 'insertReplacementText':
				typeText(event.data ?? '');
				return;
			case 'insertFromPaste':
				onpaste(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
				return;
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
		bind:textContent={typed}
		onbeforeinput={onBeforeInput}
		oncompositionend={onCompositionEnd}
		onfocus={() => {
			open = true;
			onkeyboard?.(true);
		}}
		onblur={() => {
			open = false;
			onkeyboard?.(false);
		}}
	></div>
</div>

<style>
	/* Every key in sight: the row wraps instead of hiding keys off to the side. */
	.keys {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
		gap: var(--space-2);
	}

	.key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		height: 40px;
		padding: 0 var(--space-1);
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
