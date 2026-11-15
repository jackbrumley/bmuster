import { describe, expect, it } from 'vitest';
import { isControlsShortcut } from './controls-shortcut.ts';

// SPEC-DESKTOP-FLOATING FB14: Ctrl+Alt+Home collapses and expands the floating control.

const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe('the controls shortcut', () => {
	it('FB14: is Ctrl+Alt+Home with no other modifier, and nothing else', () => {
		expect(isControlsShortcut({ ...NONE, code: 'Home', ctrlKey: true, altKey: true })).toBe(true);
		expect(isControlsShortcut({ ...NONE, code: 'Home' })).toBe(false);
		expect(isControlsShortcut({ ...NONE, code: 'Home', ctrlKey: true })).toBe(false);
		expect(isControlsShortcut({ ...NONE, code: 'Home', altKey: true })).toBe(false);
		expect(
			isControlsShortcut({ ...NONE, code: 'Home', ctrlKey: true, altKey: true, shiftKey: true })
		).toBe(false);
		expect(
			isControlsShortcut({ ...NONE, code: 'Home', ctrlKey: true, altKey: true, metaKey: true })
		).toBe(false);
		expect(isControlsShortcut({ ...NONE, code: 'End', ctrlKey: true, altKey: true })).toBe(false);
		expect(isControlsShortcut({ ...NONE, code: 'Delete', ctrlKey: true, altKey: true })).toBe(
			false
		);
	});
});
