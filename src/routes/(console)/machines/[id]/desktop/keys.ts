import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';

/**
 * Keys the viewer's own system catches or a phone keyboard lacks
 * (SPEC-DESKTOP-KEYS, SPEC-DESKTOP 5.3): the phone's key bar, the Keys
 * menu's shortcuts and its custom combination. Everything except
 * Ctrl+Alt+Del goes as plain `key` messages by position
 * (`KeyboardEvent.code`), so the agent needs nothing new.
 */

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'win';

/** The order modifiers go down in, whatever order they were picked in. */
export const MODIFIERS: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'win'];

const MODIFIER_KEYS: Readonly<Record<Modifier, { code: string; key: string }>> = {
	ctrl: { code: 'ControlLeft', key: 'Control' },
	alt: { code: 'AltLeft', key: 'Alt' },
	shift: { code: 'ShiftLeft', key: 'Shift' },
	win: { code: 'MetaLeft', key: 'Meta' }
};

/** A modifier as the machine's own keyboard names it. */
export function modifierLabel(modifier: Modifier, os: OsFamily): string {
	switch (modifier) {
		case 'ctrl':
			return 'Ctrl';
		case 'shift':
			return 'Shift';
		case 'alt':
			return os === 'macos' ? 'Option' : 'Alt';
		case 'win':
			switch (os) {
				case 'windows':
					return 'Win';
				case 'linux':
					return 'Super';
				case 'macos':
					return 'Cmd';
			}
	}
}

/** A key by position, with what it types (`KeyboardEvent.key`) and its name on screen. */
export type PlainKey = { code: string; key: string; label: string };

export type Chord = { modifiers: readonly Modifier[]; key: PlainKey };

function ordered(modifiers: readonly Modifier[]): Modifier[] {
	return MODIFIERS.filter((modifier) => modifiers.includes(modifier));
}

/** Modifiers down (Ctrl, Alt, Shift, Win), the key down and up, then the modifiers up in reverse. */
export function chordMessages(chord: {
	modifiers: readonly Modifier[];
	key: { code: string; key: string };
}): InputMessage[] {
	const held = ordered(chord.modifiers).map((modifier) => MODIFIER_KEYS[modifier]);
	const press = (item: { code: string; key: string }, down: boolean): InputMessage => ({
		type: 'key',
		code: item.code,
		key: item.key,
		down,
		altGr: false
	});
	return [
		...held.map((item) => press(item, true)),
		press(chord.key, true),
		press(chord.key, false),
		...held.reverse().map((item) => press(item, false))
	];
}

/** "Ctrl+Shift+Esc", in the order the modifiers go down. */
export function chordLabel(chord: Chord, os: OsFamily): string {
	return [
		...ordered(chord.modifiers).map((modifier) => modifierLabel(modifier, os)),
		chord.key.label
	].join('+');
}

function letter(upper: string): PlainKey {
	return { code: `Key${upper}`, key: upper.toLowerCase(), label: upper };
}

function digit(value: number): PlainKey {
	return { code: `Digit${value}`, key: String(value), label: String(value) };
}

function functionKey(value: number): PlainKey {
	return { code: `F${value}`, key: `F${value}`, label: `F${value}` };
}

const ENTER: PlainKey = { code: 'Enter', key: 'Enter', label: 'Enter' };
const TAB: PlainKey = { code: 'Tab', key: 'Tab', label: 'Tab' };
const ESCAPE: PlainKey = { code: 'Escape', key: 'Escape', label: 'Esc' };
const DELETE: PlainKey = { code: 'Delete', key: 'Delete', label: 'Delete' };
const PRINT_SCREEN: PlainKey = { code: 'PrintScreen', key: 'PrintScreen', label: 'Print Screen' };

export type PickGroupId = 'letters' | 'digits' | 'function' | 'other';

/** The keys the custom combination offers, by group. */
export const PICK_GROUPS: readonly { id: PickGroupId; label: string; keys: readonly PlainKey[] }[] =
	[
		{
			id: 'letters',
			label: 'Letters',
			keys: Array.from({ length: 26 }, (_, index) => letter(String.fromCharCode(65 + index)))
		},
		{ id: 'digits', label: 'Digits', keys: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(digit) },
		{
			id: 'function',
			label: 'F1–F12',
			keys: Array.from({ length: 12 }, (_, index) => functionKey(index + 1))
		},
		{
			id: 'other',
			label: 'Other',
			keys: [
				ENTER,
				TAB,
				ESCAPE,
				DELETE,
				{ code: 'ArrowUp', key: 'ArrowUp', label: 'Up' },
				{ code: 'ArrowDown', key: 'ArrowDown', label: 'Down' },
				{ code: 'ArrowLeft', key: 'ArrowLeft', label: 'Left' },
				{ code: 'ArrowRight', key: 'ArrowRight', label: 'Right' }
			]
		}
	];

/** The pickable key at `code` (from a key pressed on the viewer's keyboard), if it is one. */
export function pickableKey(code: string): PlainKey | undefined {
	return PICK_GROUPS.flatMap((group) => group.keys).find((item) => item.code === code);
}

/** The group a pickable key is in. */
export function groupOf(code: string): PickGroupId | undefined {
	return PICK_GROUPS.find((group) => group.keys.some((item) => item.code === code))?.id;
}

/** One entry of the Keys menu: `hint` says what it does on that machine. */
export type Shortcut = { id: string; label: string; hint: string } & (
	{ kind: 'chord'; chord: Chord } | { kind: 'ctrl-alt-del' }
);

function shortcut(id: string, hint: string, chord: Chord, os: OsFamily): Shortcut {
	return { id, label: chordLabel(chord, os), hint, kind: 'chord', chord };
}

/** The Windows key pressed on its own, named for the machine. */
function metaKey(os: OsFamily): PlainKey {
	return { code: 'MetaLeft', key: 'Meta', label: modifierLabel('win', os) };
}

function ctrlAltDel(hint: string): Shortcut {
	return { id: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', hint, kind: 'ctrl-alt-del' };
}

/** The Keys menu's shortcuts for the machine's OS family, labelled for it. */
export function shortcutsFor(os: OsFamily): readonly Shortcut[] {
	const meta = metaKey(os);
	const altTab = shortcut('alt-tab', 'Switch windows', { modifiers: ['alt'], key: TAB }, os);
	const altF4 = shortcut('alt-f4', 'Close window', { modifiers: ['alt'], key: functionKey(4) }, os);
	const lock = shortcut('lock', 'Lock', { modifiers: ['win'], key: letter('L') }, os);
	const print = shortcut('print-screen', 'Screenshot', { modifiers: [], key: PRINT_SCREEN }, os);
	switch (os) {
		case 'windows':
			return [
				ctrlAltDel('Security screen'),
				shortcut('win', 'Start menu', { modifiers: [], key: meta }, os),
				altTab,
				altF4,
				lock,
				shortcut('desktop', 'Show desktop', { modifiers: ['win'], key: letter('D') }, os),
				shortcut('run', 'Run', { modifiers: ['win'], key: letter('R') }, os),
				shortcut('task-manager', 'Task Manager', { modifiers: ['ctrl', 'shift'], key: ESCAPE }, os),
				print
			];
		case 'linux':
			return [
				ctrlAltDel('Can restart at a text console'),
				shortcut('win', 'Activities', { modifiers: [], key: meta }, os),
				altTab,
				altF4,
				lock,
				print
			];
		case 'macos':
			return [
				shortcut('win', 'Command', { modifiers: [], key: meta }, os),
				shortcut('app-switch', 'Switch apps', { modifiers: ['win'], key: TAB }, os),
				shortcut('quit', 'Quit app', { modifiers: ['win'], key: letter('Q') }, os),
				shortcut('lock', 'Lock', { modifiers: ['ctrl', 'win'], key: letter('Q') }, os)
			];
	}
}

/** One key of the phone's key bar. */
export type BarKey = { id: string; label: string; text: string } & (
	{ kind: 'key'; code: string; key: string } | { kind: 'ctrl' } | { kind: 'alt' }
);

/** The phone's key bar; the Windows key takes the machine's name for it. */
export function keyBarFor(os: OsFamily): readonly BarKey[] {
	const win = modifierLabel('win', os);
	return [
		{ id: 'esc', label: 'Escape', text: 'Esc', kind: 'key', code: 'Escape', key: 'Escape' },
		{ id: 'tab', label: 'Tab', text: 'Tab', kind: 'key', code: 'Tab', key: 'Tab' },
		{ id: 'ctrl', label: 'Ctrl, for the next key', text: 'Ctrl', kind: 'ctrl' },
		{ id: 'alt', label: 'Alt, for the next key', text: 'Alt', kind: 'alt' },
		{ id: 'win', label: `${win} key`, text: win, kind: 'key', code: 'MetaLeft', key: 'Meta' },
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
		}
	];
}

/** A letter or digit as the key that types it, for shortcuts like Ctrl+C typed on a phone. */
export function characterKeys(text: string): { code: string; key: string } | undefined {
	if (!/^[a-z0-9]$/i.test(text)) {
		return undefined;
	}
	const upper = text.toUpperCase();
	return { code: /\d/.test(text) ? `Digit${text}` : `Key${upper}`, key: text.toLowerCase() };
}
