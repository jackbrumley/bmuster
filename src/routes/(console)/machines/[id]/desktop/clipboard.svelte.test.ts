import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_REPLY_MS, DesktopClipboard } from './clipboard.svelte.ts';

// SPEC-DESKTOP 21: C10. Ctrl+V into the screen (21.12) is in paste-shortcut.svelte.test.ts.

afterEach(() => {
	vi.useRealTimers();
});

describe('copy and paste on the desktop', () => {
	it('C10: says the machine did not answer when no reply comes within 10 s', () => {
		vi.useFakeTimers();
		const clipboard = new DesktopClipboard(() => undefined);
		clipboard.pull();
		expect(clipboard.waiting).toBe('pull');
		vi.advanceTimersByTime(CLIPBOARD_REPLY_MS - 1);
		expect(clipboard.note).toEqual({ kind: 'none' });
		vi.advanceTimersByTime(1);
		expect(clipboard.waiting).toBe('none');
		expect(clipboard.note).toEqual({
			kind: 'error',
			message:
				'The machine did not answer. Its agent may be too old for copy and paste: update it from Manage.'
		});
	});
});
