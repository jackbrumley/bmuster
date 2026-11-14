import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { MAX_CLIPBOARD_BYTES, type ViewerMessage } from '#lib/domain/desktop/messages.ts';
import { toasts } from '#lib/ui/toast.svelte.ts';
import { DesktopClipboard, PASTE_SYNC_MS } from './clipboard.svelte.ts';
import { attachPasteShortcut, PASTE_EVENT_MS } from './paste-shortcut.ts';

// SPEC-DESKTOP 21.12: C41, C42, C43, C44, C45, C46.

afterEach(() => {
	vi.useRealTimers();
	toasts.list = [];
	document.body.replaceChildren();
});

/**
 * The screen, with its own key handler listening as screen-input.ts does (only events aimed at
 * the screen itself), and the paste shortcut attached in front of it.
 */
function screen(options: { sharing: boolean; controlling: boolean }) {
	const sent: ViewerMessage[] = [];
	const clipboard = new DesktopClipboard((message) => {
		sent.push(message);
	});
	clipboard.sharing = options.sharing;
	const surface = document.createElement('div');
	surface.tabIndex = 0;
	document.body.append(surface);
	const screenKeys: string[] = [];
	const record = (prefix: string) => (event: KeyboardEvent) => {
		if (event.target === surface) {
			screenKeys.push(`${prefix}${event.code}`);
		}
	};
	surface.addEventListener('keydown', record('+'));
	surface.addEventListener('keyup', record('-'));
	const detach = attachPasteShortcut(surface, {
		clipboard,
		send: (message) => {
			sent.push(message);
		},
		controlling: () => options.controlling
	});
	surface.focus();
	return { sent, clipboard, surface, screenKeys, detach };
}

type Held = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

const KEY_NAMES: Record<string, string> = {
	KeyV: 'v',
	KeyA: 'a',
	Insert: 'Insert',
	ControlLeft: 'Control',
	MetaLeft: 'Meta',
	ShiftLeft: 'Shift'
};

/** A key event on whatever has the keyboard, as the browser aims it; returns it to inspect. */
function press(type: 'keydown' | 'keyup', code: string, held: Held): KeyboardEvent {
	const event = new KeyboardEvent(type, {
		code,
		key: KEY_NAMES[code] ?? code,
		...held,
		bubbles: true,
		cancelable: true
	});
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}

/** The browser's paste, aimed at whatever has the keyboard; `undefined` pastes no text. */
function paste(text: string | undefined): ClipboardEvent {
	const event = new ClipboardEvent('paste', {
		clipboardData: new DataTransfer(),
		bubbles: true,
		cancelable: true
	});
	// Set on the event's own data: Firefox drops what a DataTransfer held before the event was made.
	if (text !== undefined) {
		event.clipboardData?.setData('text/plain', text);
	}
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}

/** "+KeyV" for a key down message, "-KeyV" for up; other messages by type. */
function strokes(sent: ViewerMessage[]): string[] {
	return sent.map((message) =>
		message.type === 'key' ? `${message.down ? '+' : '-'}${message.code}` : message.type
	);
}

const CTRL = { ctrlKey: true };

describe('Ctrl+V into the screen (SPEC-DESKTOP 21.12)', () => {
	it('C41: Ctrl+V with clipboard text syncs it, then sends Ctrl+V once the machine has it', async () => {
		const { sent, clipboard, surface, screenKeys } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		const down = press('keydown', 'KeyV', CTRL);
		// The browser must go on to paste: the key down is never cancelled.
		expect(down.defaultPrevented).toBe(false);
		expect(document.activeElement).not.toBe(surface);
		const pasted = paste('copied here');
		// The text never lands in the hidden box, and the screen has the keyboard again.
		expect(pasted.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(surface);
		press('keyup', 'KeyV', CTRL);
		await vi.waitFor(() => {
			expect(sent).toEqual([{ type: 'clipboard-sync', text: 'copied here' }]);
		});
		// The screen's own handler saw only Ctrl: the shortcut sends the V after the sync.
		expect(screenKeys).toEqual(['+ControlLeft']);
		clipboard.synced();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual(['clipboard-sync', '+KeyV', '-KeyV']);
		});
	});

	it('C41: Cmd+V and Shift+Insert are caught the same way, and replayed as pressed', async () => {
		const { sent, clipboard } = screen({ sharing: true, controlling: true });
		press('keydown', 'MetaLeft', { metaKey: true });
		press('keydown', 'KeyV', { metaKey: true });
		paste('from a Mac');
		press('keyup', 'KeyV', { metaKey: true });
		press('keyup', 'MetaLeft', {});
		clipboard.synced();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual(['clipboard-sync', '+MetaLeft', '+KeyV', '-KeyV', '-MetaLeft']);
		});
		sent.length = 0;
		press('keydown', 'ShiftLeft', { shiftKey: true });
		press('keydown', 'Insert', { shiftKey: true });
		paste('from Linux');
		clipboard.synced();
		await vi.waitFor(() => {
			expect(sent).toEqual([
				{ type: 'clipboard-sync', text: 'from Linux' },
				{ type: 'key', code: 'Insert', key: 'Insert', down: true, altGr: false },
				{ type: 'key', code: 'Insert', key: 'Insert', down: false, altGr: false }
			]);
		});
	});

	it('C42: a paste with no text sends the keys only', async () => {
		const { sent, surface } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		paste(undefined);
		expect(document.activeElement).toBe(surface);
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual(['+KeyV', '-KeyV']);
		});
	});

	it('C42: no paste event in time sends the keys, pressing Ctrl again if it was let go', () => {
		vi.useFakeTimers();
		const { sent, surface, screenKeys } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		// Released while the hidden box had the keyboard: the screen still hears the release.
		press('keyup', 'KeyV', CTRL);
		press('keyup', 'ControlLeft', {});
		expect(document.activeElement).toBe(surface);
		expect(screenKeys).toEqual(['+ControlLeft', '-ControlLeft']);
		vi.advanceTimersByTime(PASTE_EVENT_MS - 1);
		expect(sent).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(strokes(sent)).toEqual(['+ControlLeft', '+KeyV', '-KeyV', '-ControlLeft']);
	});

	it('C42: other keys that reach the hidden box go on to the screen', () => {
		vi.useFakeTimers();
		const { surface, screenKeys } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		const typed = press('keydown', 'KeyA', CTRL);
		expect(typed.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(surface);
		expect(screenKeys).toEqual(['+ControlLeft', '+KeyA']);
	});

	it('C43: with Share clipboard off, Ctrl+V goes to the screen untouched', () => {
		const { sent, surface, screenKeys } = screen({ sharing: false, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		expect(document.activeElement).toBe(surface);
		press('keyup', 'KeyV', CTRL);
		expect(screenKeys).toEqual(['+ControlLeft', '+KeyV', '-KeyV']);
		expect(sent).toEqual([]);
	});

	it('C43: without control, Ctrl+V goes to the screen untouched', () => {
		const { sent, surface, screenKeys } = screen({ sharing: true, controlling: false });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		expect(document.activeElement).toBe(surface);
		expect(screenKeys).toEqual(['+ControlLeft', '+KeyV']);
		expect(sent).toEqual([]);
	});

	it('C44: text over 1 MiB says so, and sends neither the text nor the keys', async () => {
		vi.useFakeTimers();
		const { sent } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		paste('x'.repeat(MAX_CLIPBOARD_BYTES + 1));
		await vi.advanceTimersByTimeAsync(PASTE_SYNC_MS + PASTE_EVENT_MS);
		expect(sent).toEqual([]);
		expect(toasts.list.map((toast) => [toast.message, toast.tone])).toEqual([
			['The text is over 1 MB. Copy and paste carries at most 1 MB at a time.', 'error']
		]);
	});

	it('C45: no answer within 2 s still sends the keys', async () => {
		vi.useFakeTimers();
		const { sent } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		paste('copied here');
		await vi.advanceTimersByTimeAsync(PASTE_SYNC_MS - 1);
		expect(strokes(sent)).toEqual(['clipboard-sync']);
		await vi.advanceTimersByTimeAsync(1);
		expect(strokes(sent)).toEqual(['clipboard-sync', '+KeyV', '-KeyV']);
	});

	it('C45: a failed sync still sends the keys', async () => {
		const { sent, clipboard } = screen({ sharing: true, controlling: true });
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		paste('copied here');
		clipboard.syncFailed();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual(['clipboard-sync', '+KeyV', '-KeyV']);
		});
	});

	it("C45: an earlier sync's answer does not release this paste", async () => {
		vi.useFakeTimers();
		const { sent, clipboard } = screen({ sharing: true, controlling: true });
		// A focus sync already on its way (21.11), answered after the paste's sync is sent.
		void clipboard.syncForPaste('copied before');
		press('keydown', 'ControlLeft', CTRL);
		press('keydown', 'KeyV', CTRL);
		paste('copied here');
		await vi.advanceTimersByTimeAsync(0);
		sent.splice(0, sent.length - 1);
		clipboard.synced();
		await vi.advanceTimersByTimeAsync(0);
		expect(strokes(sent)).toEqual(['clipboard-sync']);
		clipboard.synced();
		await vi.advanceTimersByTimeAsync(0);
		expect(strokes(sent)).toEqual(['clipboard-sync', '+KeyV', '-KeyV']);
	});

	it("C46: a real Ctrl+V key press is caught with the clipboard's text", async () => {
		// Put text on the real clipboard the way a person does: select it and press Ctrl+C.
		const source = document.createElement('textarea');
		source.value = 'typed on this computer';
		document.body.append(source);
		source.focus();
		source.select();
		await userEvent.keyboard('{Control>}c{/Control}');
		const { sent, clipboard, surface, screenKeys } = screen({ sharing: true, controlling: true });
		await userEvent.keyboard('{Control>}v{/Control}');
		await vi.waitFor(() => {
			expect(sent).toEqual([{ type: 'clipboard-sync', text: 'typed on this computer' }]);
		});
		// The screen had the keyboard again for the releases, and heard Ctrl's.
		expect(document.activeElement).toBe(surface);
		expect(screenKeys).toEqual(['+ControlLeft', '-ControlLeft']);
		clipboard.synced();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual([
				'clipboard-sync',
				'+ControlLeft',
				'+KeyV',
				'-KeyV',
				'-ControlLeft'
			]);
		});
	});
});
