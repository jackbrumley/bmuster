import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import {
	chordLabel,
	chordMessages,
	PICK_GROUPS,
	pickableKey,
	shortcutsFor,
	type Shortcut
} from './keys.ts';

// SPEC-DESKTOP-KEYS K1, K2, K3, K7.

const ESC = { code: 'Escape', key: 'Escape', label: 'Esc' };

function key(code: string, keyValue: string, down: boolean) {
	return { type: 'key', code, key: keyValue, down, altGr: false };
}

function labels(os: OsFamily): string[] {
	return shortcutsFor(os).map((shortcut) => shortcut.label);
}

function chordOf(shortcut: Shortcut | undefined) {
	if (shortcut?.kind !== 'chord') throw new Error('not a chord');
	return shortcut.chord;
}

describe('chords', () => {
	it('K1: presses modifiers in Ctrl, Alt, Shift, Win order, the key, then releases in reverse', () => {
		const messages = chordMessages({ modifiers: ['win', 'shift', 'ctrl', 'shift'], key: ESC });
		expect(messages).toEqual([
			key('ControlLeft', 'Control', true),
			key('ShiftLeft', 'Shift', true),
			key('MetaLeft', 'Meta', true),
			key('Escape', 'Escape', true),
			key('Escape', 'Escape', false),
			key('MetaLeft', 'Meta', false),
			key('ShiftLeft', 'Shift', false),
			key('ControlLeft', 'Control', false)
		]);
	});

	it('K1: a lone key is a tap', () => {
		expect(chordMessages({ modifiers: [], key: ESC })).toEqual([
			key('Escape', 'Escape', true),
			key('Escape', 'Escape', false)
		]);
	});

	it('K7: the phone bar latches Ctrl and Alt around the next key through the same function', () => {
		const messages = chordMessages({
			modifiers: ['alt', 'ctrl'],
			key: { code: 'KeyC', key: 'c' }
		});
		expect(messages.map((message) => (message.type === 'key' ? message.code : '?'))).toEqual([
			'ControlLeft',
			'AltLeft',
			'KeyC',
			'KeyC',
			'AltLeft',
			'ControlLeft'
		]);
	});

	it('labels a chord for the machine, in the fixed modifier order', () => {
		const chord = { modifiers: ['shift', 'ctrl'] as const, key: ESC };
		expect(chordLabel(chord, 'windows')).toBe('Ctrl+Shift+Esc');
		expect(chordLabel({ modifiers: ['win'], key: ESC }, 'linux')).toBe('Super+Esc');
		expect(chordLabel({ modifiers: ['win', 'alt'], key: ESC }, 'macos')).toBe('Option+Cmd+Esc');
	});
});

describe('shortcuts per OS family', () => {
	it('K2: Windows has the Windows shortcuts, with Ctrl+Alt+Del as the special key', () => {
		expect(labels('windows')).toEqual([
			'Ctrl+Alt+Del',
			'Win',
			'Alt+Tab',
			'Alt+F4',
			'Win+L',
			'Win+D',
			'Win+R',
			'Ctrl+Shift+Esc',
			'Print Screen'
		]);
		expect(shortcutsFor('windows')[0]?.kind).toBe('ctrl-alt-del');
		const run = shortcutsFor('windows').find((shortcut) => shortcut.label === 'Win+R');
		expect(chordMessages(chordOf(run)).at(0)).toEqual(key('MetaLeft', 'Meta', true));
	});

	it('K2: Linux says Super and has no Windows-only shortcuts', () => {
		expect(labels('linux')).toEqual([
			'Ctrl+Alt+Del',
			'Super',
			'Alt+Tab',
			'Alt+F4',
			'Super+L',
			'Print Screen'
		]);
	});

	it('K2: macOS has Cmd shortcuts and no Ctrl+Alt+Del', () => {
		expect(labels('macos')).toEqual(['Cmd', 'Cmd+Tab', 'Cmd+Q', 'Ctrl+Cmd+Q']);
		expect(shortcutsFor('macos').some((shortcut) => shortcut.kind === 'ctrl-alt-del')).toBe(false);
	});

	it('K2: every shortcut has a short description and a unique id', () => {
		for (const os of ['windows', 'linux', 'macos'] as const) {
			const list = shortcutsFor(os);
			expect(new Set(list.map((shortcut) => shortcut.id)).size).toBe(list.length);
			expect(list.every((shortcut) => shortcut.hint.length > 0)).toBe(true);
		}
	});
});

describe('pickable keys', () => {
	const keymap = readFileSync(
		join(process.cwd(), 'agent/crates/desktop/src/input/keymap.rs'),
		'utf8'
	);
	const all = PICK_GROUPS.flatMap((group) => group.keys);

	it('K3: has letters, digits, F1 to F12 and the other keys, each known to the agent', () => {
		expect(PICK_GROUPS.map((group) => group.keys.length)).toEqual([26, 10, 12, 8]);
		for (const item of all) {
			expect(keymap).toContain(`"${item.code}"`);
		}
		for (const os of ['windows', 'linux', 'macos'] as const) {
			for (const shortcut of shortcutsFor(os)) {
				if (shortcut.kind === 'chord') {
					expect(keymap).toContain(`"${shortcut.chord.key.code}"`);
				}
			}
		}
	});

	it('K3: Press a key accepts exactly the pickable keys', () => {
		for (const item of all) {
			expect(pickableKey(item.code)).toEqual(item);
		}
		expect(pickableKey('ShiftLeft')).toBeUndefined();
		expect(pickableKey('NumpadAdd')).toBeUndefined();
		expect(pickableKey('KeyQ')).toEqual({ code: 'KeyQ', key: 'q', label: 'Q' });
	});
});
