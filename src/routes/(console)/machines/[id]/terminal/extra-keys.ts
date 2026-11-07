/**
 * The row of extra keys a phone keyboard lacks (SPEC-SESSIONS T5), and the
 * bytes each sends. Ctrl and Alt latch: they apply to the next key, from
 * this row or the phone's own keyboard, then let go.
 */

export type ExtraKeyId =
	| 'esc'
	| 'tab'
	| 'ctrl'
	| 'alt'
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'pipe'
	| 'tilde'
	| 'slash'
	| 'dash';

export type ExtraKey = { id: ExtraKeyId; label: string; name: string };

export const EXTRA_KEYS: readonly ExtraKey[] = [
	{ id: 'esc', label: 'Esc', name: 'Escape' },
	{ id: 'tab', label: 'Tab', name: 'Tab' },
	{ id: 'ctrl', label: 'Ctrl', name: 'Control (applies to the next key)' },
	{ id: 'alt', label: 'Alt', name: 'Alt (applies to the next key)' },
	{ id: 'up', label: '↑', name: 'Up arrow' },
	{ id: 'down', label: '↓', name: 'Down arrow' },
	{ id: 'left', label: '←', name: 'Left arrow' },
	{ id: 'right', label: '→', name: 'Right arrow' },
	{ id: 'pipe', label: '|', name: 'Pipe' },
	{ id: 'tilde', label: '~', name: 'Tilde' },
	{ id: 'slash', label: '/', name: 'Slash' },
	{ id: 'dash', label: '-', name: 'Dash' }
];

export type Modifiers = { ctrl: boolean; alt: boolean };

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

const ARROW_LETTER = { up: 'A', down: 'B', right: 'C', left: 'D' } as const;

/** Control characters for the punctuation that has one (Ctrl+[ is Esc, Ctrl+? is Delete). */
const CONTROL_PUNCTUATION: Readonly<Record<string, string>> = {
	' ': '\x00',
	'@': '\x00',
	'[': '\x1b',
	'\\': '\x1c',
	']': '\x1d',
	'^': '\x1e',
	_: '\x1f',
	'?': '\x7f'
};

/** Ctrl and Alt on typed text: Ctrl turns one letter into its control character; Alt prefixes Esc. */
export function withModifiers(data: string, modifiers: Modifiers): string {
	let result = data;
	if (modifiers.ctrl && result.length === 1) {
		const code = result.toUpperCase().charCodeAt(0);
		if (code >= 0x41 && code <= 0x5a) {
			result = String.fromCharCode(code & 0x1f);
		} else {
			result = CONTROL_PUNCTUATION[result] ?? result;
		}
	}
	return modifiers.alt ? `\x1b${result}` : result;
}

/**
 * The bytes for a key in the row (not Ctrl or Alt themselves), with the
 * latched modifiers. Arrows follow the terminal's cursor key mode: full-screen
 * programs (vim, less) ask for `ESC O A`, the shell gets `ESC [ A`; with a
 * modifier they are `ESC [ 1 ; <mod> A` like a desktop keyboard sends.
 */
export function keySequence(
	key: Exclude<ExtraKeyId, 'ctrl' | 'alt'>,
	modifiers: Modifiers,
	applicationCursor: boolean
): string {
	switch (key) {
		case 'up':
		case 'down':
		case 'left':
		case 'right': {
			const letter = ARROW_LETTER[key];
			if (modifiers.ctrl || modifiers.alt) {
				const code = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
				return `\x1b[1;${code}${letter}`;
			}
			return applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
		}
		case 'esc':
			return withModifiers('\x1b', { ctrl: false, alt: modifiers.alt });
		case 'tab':
			return withModifiers('\t', { ctrl: false, alt: modifiers.alt });
		case 'pipe':
			return withModifiers('|', modifiers);
		case 'tilde':
			return withModifiers('~', modifiers);
		case 'slash':
			return withModifiers('/', modifiers);
		case 'dash':
			return withModifiers('-', modifiers);
	}
}
