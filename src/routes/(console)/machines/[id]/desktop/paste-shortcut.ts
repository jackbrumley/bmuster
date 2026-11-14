import type { ViewerMessage } from '#lib/domain/desktop/messages.ts';
import type { DesktopClipboard } from './clipboard.svelte.ts';

/**
 * Ctrl+V into the screen pastes this device's text on the machine, in every browser
 * (SPEC-DESKTOP 21.12). Browsers hand a page the text of a paste the person makes, in a `paste`
 * event, without a permission; reading the clipboard any other way needs one only Chromium
 * grants. The screen is not editable, and Safari fires `paste` only into an editable element
 * (Firefox fires it at the body), so on the chord's key down the keyboard moves to a hidden text
 * box inside the screen and the browser pastes there. The key down is never cancelled: a
 * cancelled one never pastes.
 */

/** How long the chord waits for the browser's `paste` before sending the keys without text. */
export const PASTE_EVENT_MS = 150;

type KeyName = { code: string; key: string };

/** A modifier by both of its positions, and the one pressed for the machine when it was let go. */
type Modifier = { codes: readonly string[]; press: KeyName };

/** A paste chord: its key, and the modifier held with it. */
type PasteChord = { key: KeyName; modifier: Modifier };

const CONTROL: Modifier = {
	codes: ['ControlLeft', 'ControlRight'],
	press: { code: 'ControlLeft', key: 'Control' }
};
const META: Modifier = {
	codes: ['MetaLeft', 'MetaRight'],
	press: { code: 'MetaLeft', key: 'Meta' }
};
const SHIFT: Modifier = {
	codes: ['ShiftLeft', 'ShiftRight'],
	press: { code: 'ShiftLeft', key: 'Shift' }
};
const KEY_V: KeyName = { code: 'KeyV', key: 'v' };
const INSERT: KeyName = { code: 'Insert', key: 'Insert' };

/**
 * Ctrl+V, Cmd+V (Apple keyboards) or Shift+Insert, each with no other modifier and not a
 * repeat; anything else is undefined.
 */
function pasteChord(event: KeyboardEvent): PasteChord | undefined {
	if (event.repeat || event.altKey) {
		return undefined;
	}
	const only = (ctrl: boolean, meta: boolean, shift: boolean) =>
		event.ctrlKey === ctrl && event.metaKey === meta && event.shiftKey === shift;
	if (event.code === 'KeyV' && only(true, false, false)) {
		return { key: KEY_V, modifier: CONTROL };
	}
	if (event.code === 'KeyV' && only(false, true, false)) {
		return { key: KEY_V, modifier: META };
	}
	if (event.code === 'Insert' && only(false, false, true)) {
		return { key: INSERT, modifier: SHIFT };
	}
	return undefined;
}

/** Where a caught chord is: waiting for the browser's paste, or for the machine to have the text. */
type Catch =
	| { kind: 'none' }
	| { kind: 'paste'; chord: PasteChord; timer: ReturnType<typeof setTimeout> }
	| { kind: 'sync'; chord: PasteChord };

/**
 * Attaches the shortcut in front of the screen's own key handler (it listens in the capture
 * phase, so it decides first). With Share clipboard off or without control the keys pass
 * through untouched. Returns the detach function.
 */
export function attachPasteShortcut(
	surface: HTMLElement,
	host: {
		clipboard: DesktopClipboard;
		send: (message: Extract<ViewerMessage, { type: 'key' }>) => void;
		controlling: () => boolean;
	}
): () => void {
	const catcher = pasteCatcher();
	surface.append(catcher);
	/** Keys held on the screen, by position: the replay presses a modifier only if it was let go. */
	const held = new Set<string>();
	let caught: Catch = { kind: 'none' };
	/** The caught chord's key release, which the replay has (or will have) sent itself. */
	let swallowRelease: string | undefined;

	const key = (name: KeyName, down: boolean) => {
		host.send({ type: 'key', code: name.code, key: name.key, down, altGr: false });
	};
	const backToScreen = () => {
		if (document.activeElement === catcher) {
			surface.focus({ preventScroll: true });
		}
	};
	const pressKeys = (chord: PasteChord) => {
		caught = { kind: 'none' };
		if (!host.controlling()) {
			return;
		}
		const pressModifier = !chord.modifier.codes.some((code) => held.has(code));
		if (pressModifier) {
			key(chord.modifier.press, true);
		}
		key(chord.key, true);
		key(chord.key, false);
		if (pressModifier) {
			key(chord.modifier.press, false);
		}
	};
	const pasted = (chord: PasteChord, text: string) => {
		backToScreen();
		if (text === '') {
			pressKeys(chord);
			return;
		}
		caught = { kind: 'sync', chord };
		void host.clipboard.syncForPaste(text).then((answer) => {
			if (answer === 'paste') {
				pressKeys(chord);
			} else {
				caught = { kind: 'none' };
			}
		});
	};
	/** A key aimed at the hidden box goes on to the screen, as though the screen had the keyboard. */
	const forward = (event: KeyboardEvent) => {
		backToScreen();
		surface.dispatchEvent(
			new KeyboardEvent(event.type, {
				code: event.code,
				key: event.key,
				location: event.location,
				repeat: event.repeat,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				metaKey: event.metaKey,
				bubbles: true,
				cancelable: true
			})
		);
	};
	const isCaughtKey = (code: string) => caught.kind !== 'none' && caught.chord.key.code === code;

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.target === catcher) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (!isCaughtKey(event.code)) {
				forward(event);
			}
			return;
		}
		if (event.target !== surface) {
			return;
		}
		held.add(event.code);
		if (isCaughtKey(event.code)) {
			// A repeat or a second press while the first is on its way: one paste.
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		const chord = pasteChord(event);
		if (chord === undefined || !host.controlling() || !host.clipboard.sharing) {
			return;
		}
		// The screen's handler never sees it, and the browser goes on to paste into the box.
		event.stopImmediatePropagation();
		swallowRelease = chord.key.code;
		catcher.value = '';
		catcher.focus({ preventScroll: true });
		caught = {
			kind: 'paste',
			chord,
			timer: setTimeout(() => {
				backToScreen();
				pressKeys(chord);
			}, PASTE_EVENT_MS)
		};
	};
	const onKeyUp = (event: KeyboardEvent) => {
		if (event.target !== surface && event.target !== catcher) {
			return;
		}
		if (swallowRelease === event.code) {
			swallowRelease = undefined;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.target === catcher) {
				backToScreen();
			}
			held.delete(event.code);
			return;
		}
		if (event.target === catcher) {
			event.preventDefault();
			event.stopImmediatePropagation();
			forward(event);
			return;
		}
		held.delete(event.code);
	};
	const onPaste = (event: ClipboardEvent) => {
		// The text never stays in the box, whether or not a chord is waiting for it.
		event.preventDefault();
		if (caught.kind !== 'paste') {
			backToScreen();
			return;
		}
		clearTimeout(caught.timer);
		pasted(caught.chord, event.clipboardData?.getData('text/plain') ?? '');
	};
	const forget = () => {
		held.clear();
	};

	surface.addEventListener('keydown', onKeyDown, { capture: true });
	surface.addEventListener('keyup', onKeyUp, { capture: true });
	catcher.addEventListener('paste', onPaste);
	window.addEventListener('blur', forget);
	return () => {
		if (caught.kind === 'paste') {
			clearTimeout(caught.timer);
		}
		caught = { kind: 'none' };
		surface.removeEventListener('keydown', onKeyDown, { capture: true });
		surface.removeEventListener('keyup', onKeyUp, { capture: true });
		catcher.removeEventListener('paste', onPaste);
		window.removeEventListener('blur', forget);
		catcher.remove();
	};
}

/**
 * The hidden box the browser pastes into: out of sight and out of the way of the pointer, never
 * reached with Tab, hidden from screen readers, and `inputmode="none"` so a phone or tablet never
 * opens its keyboard for it.
 */
function pasteCatcher(): HTMLTextAreaElement {
	const catcher = document.createElement('textarea');
	catcher.tabIndex = -1;
	catcher.autocomplete = 'off';
	catcher.spellcheck = false;
	catcher.inputMode = 'none';
	catcher.setAttribute('aria-hidden', 'true');
	Object.assign(catcher.style, {
		position: 'fixed',
		left: '0',
		top: '0',
		width: '1px',
		height: '1px',
		opacity: '0',
		pointerEvents: 'none',
		resize: 'none',
		overflow: 'hidden'
	});
	return catcher;
}
