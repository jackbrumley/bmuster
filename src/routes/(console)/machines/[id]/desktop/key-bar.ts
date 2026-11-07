/**
 * The phone's key bar for the remote screen (SPEC-DESKTOP 5.3): keys a phone
 * keyboard lacks, sent by position (`KeyboardEvent.code`).
 */

export type BarKey = { id: string; label: string; text: string } & (
	| { kind: 'key'; code: string; key: string }
	| { kind: 'ctrl' }
	| { kind: 'alt' }
	| { kind: 'ctrl-alt-del' }
);

export const KEY_BAR: readonly BarKey[] = [
	{ id: 'esc', label: 'Escape', text: 'Esc', kind: 'key', code: 'Escape', key: 'Escape' },
	{ id: 'tab', label: 'Tab', text: 'Tab', kind: 'key', code: 'Tab', key: 'Tab' },
	{ id: 'ctrl', label: 'Ctrl, for the next key', text: 'Ctrl', kind: 'ctrl' },
	{ id: 'alt', label: 'Alt, for the next key', text: 'Alt', kind: 'alt' },
	{ id: 'win', label: 'Windows key', text: 'Win', kind: 'key', code: 'MetaLeft', key: 'Meta' },
	{ id: 'up', label: 'Up', text: 'Up', kind: 'key', code: 'ArrowUp', key: 'ArrowUp' },
	{ id: 'down', label: 'Down', text: 'Down', kind: 'key', code: 'ArrowDown', key: 'ArrowDown' },
	{ id: 'left', label: 'Left', text: 'Left', kind: 'key', code: 'ArrowLeft', key: 'ArrowLeft' },
	{
		id: 'right',
		label: 'Right',
		text: 'Right',
		kind: 'key',
		code: 'ArrowRight',
		key: 'ArrowRight'
	},
	{ id: 'cad', label: 'Ctrl+Alt+Del', text: 'Ctrl+Alt+Del', kind: 'ctrl-alt-del' }
];

/** A letter or digit as the key that types it, for shortcuts like Ctrl+C typed on a phone. */
export function characterKeys(text: string): { code: string; key: string } | undefined {
	if (!/^[a-z0-9]$/i.test(text)) {
		return undefined;
	}
	const upper = text.toUpperCase();
	return { code: /\d/.test(text) ? `Digit${text}` : `Key${upper}`, key: text.toLowerCase() };
}
