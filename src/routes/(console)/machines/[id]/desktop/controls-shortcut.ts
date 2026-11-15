/**
 * The keyboard shortcut that collapses and expands the floating control
 * (SPEC-DESKTOP-FLOATING FB14): Ctrl+Alt+Home, the chord Windows' own
 * Remote Desktop uses to reach its connection bar, so few people need it on
 * the machine, and no browser takes it. BMuster keeps it: the Home key's
 * press and release never reach the screen's input, the paste shortcut or
 * the machine. Ctrl and Alt went to the machine on their own before Home
 * was pressed and go up as usual, which on its own does nothing there.
 */

export const CONTROLS_SHORTCUT = 'Ctrl+Alt+Home';

type Chord = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/** Ctrl+Alt+Home with no other modifier, by the key's position. */
export function isControlsShortcut(event: Chord): boolean {
	return (
		event.code === 'Home' && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
	);
}

/**
 * Listens on `target` (the window the controls float in) in the capture
 * phase, so the shortcut is caught before anything on the page sees it,
 * and calls `toggle` once per press while `active` (the floating bar is
 * offered); otherwise the keys pass through untouched. Returns the detach
 * function.
 */
export function attachControlsShortcut(
	target: Window,
	host: { active: () => boolean; toggle: () => void }
): () => void {
	/** Home went down as the shortcut: its release is kept too. */
	let keptRelease = false;
	const keep = (event: KeyboardEvent) => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (!isControlsShortcut(event) || !host.active()) {
			return;
		}
		keep(event);
		keptRelease = true;
		if (!event.repeat) {
			host.toggle();
		}
	};
	const onKeyUp = (event: KeyboardEvent) => {
		if (keptRelease && event.code === 'Home') {
			keptRelease = false;
			keep(event);
		}
	};
	target.addEventListener('keydown', onKeyDown, { capture: true });
	target.addEventListener('keyup', onKeyUp, { capture: true });
	return () => {
		target.removeEventListener('keydown', onKeyDown, { capture: true });
		target.removeEventListener('keyup', onKeyUp, { capture: true });
	};
}
