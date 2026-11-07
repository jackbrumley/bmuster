import { describe, expect, it } from 'vitest';
import { keySequence, NO_MODIFIERS, withModifiers } from './extra-keys.ts';

const CTRL = { ctrl: true, alt: false };
const ALT = { ctrl: false, alt: true };

describe('extra keys (T5)', () => {
	it('send Esc, Tab and the symbols as they are', () => {
		expect(keySequence('esc', NO_MODIFIERS, false)).toBe('\x1b');
		expect(keySequence('tab', NO_MODIFIERS, false)).toBe('\t');
		expect(keySequence('pipe', NO_MODIFIERS, false)).toBe('|');
		expect(keySequence('tilde', NO_MODIFIERS, false)).toBe('~');
		expect(keySequence('slash', NO_MODIFIERS, false)).toBe('/');
		expect(keySequence('dash', NO_MODIFIERS, false)).toBe('-');
	});

	it('send arrows in the mode the program asked for', () => {
		expect(keySequence('up', NO_MODIFIERS, false)).toBe('\x1b[A');
		expect(keySequence('down', NO_MODIFIERS, false)).toBe('\x1b[B');
		expect(keySequence('right', NO_MODIFIERS, false)).toBe('\x1b[C');
		expect(keySequence('left', NO_MODIFIERS, false)).toBe('\x1b[D');
		expect(keySequence('up', NO_MODIFIERS, true)).toBe('\x1bOA');
		expect(keySequence('left', NO_MODIFIERS, true)).toBe('\x1bOD');
	});

	it('Ctrl turns the next letter into its control character', () => {
		expect(withModifiers('c', CTRL)).toBe('\x03');
		expect(withModifiers('C', CTRL)).toBe('\x03');
		expect(withModifiers('d', CTRL)).toBe('\x04');
		expect(withModifiers('z', CTRL)).toBe('\x1a');
		expect(withModifiers('[', CTRL)).toBe('\x1b');
		expect(withModifiers('?', CTRL)).toBe('\x7f');
		expect(withModifiers('5', CTRL)).toBe('5');
		expect(withModifiers('ls', CTRL)).toBe('ls');
	});

	it('Alt puts Esc before the next key', () => {
		expect(withModifiers('b', ALT)).toBe('\x1bb');
		expect(withModifiers('x', { ctrl: true, alt: true })).toBe('\x1b\x18');
		expect(keySequence('esc', ALT, false)).toBe('\x1b\x1b');
	});

	it('modified arrows use the desktop keyboard form', () => {
		expect(keySequence('left', CTRL, false)).toBe('\x1b[1;5D');
		expect(keySequence('right', ALT, true)).toBe('\x1b[1;3C');
		expect(keySequence('up', { ctrl: true, alt: true }, false)).toBe('\x1b[1;7A');
	});
});
