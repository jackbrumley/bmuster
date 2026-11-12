import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerMessage } from '#lib/domain/desktop/messages.ts';
import {
	attachPasteShortcut,
	CLIPBOARD_REPLY_MS,
	DesktopClipboard,
	SHORTCUT_PUSH_MS
} from './clipboard.svelte.ts';

// SPEC-DESKTOP 20: C10, C11.

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

/**
 * The picture, with the screen's own key handler listening as screen-input.ts does, once the
 * shortcut has read the permission.
 */
async function picture(granted: boolean) {
	const readAllowed = vi.fn(() => Promise.resolve(granted));
	const sent: ViewerMessage[] = [];
	const clipboard = new DesktopClipboard((message) => {
		sent.push(message);
	});
	const surface = document.createElement('div');
	surface.tabIndex = 0;
	document.body.append(surface);
	const screenKeys: string[] = [];
	surface.addEventListener('keydown', (event) => screenKeys.push(`+${event.code}`));
	surface.addEventListener('keyup', (event) => screenKeys.push(`-${event.code}`));
	const detach = attachPasteShortcut(surface, {
		clipboard,
		send: (message) => {
			sent.push(message);
		},
		controlling: () => true,
		readAllowed
	});
	await vi.waitFor(() => {
		expect(readAllowed).toHaveBeenCalled();
	});
	await new Promise((settled) => setTimeout(settled, 0));
	return { sent, clipboard, surface, screenKeys, detach };
}

function press(surface: HTMLElement, type: 'keydown' | 'keyup', code: string, ctrlKey: boolean) {
	surface.dispatchEvent(
		new KeyboardEvent(type, {
			code,
			key: code === 'KeyV' ? 'v' : 'Control',
			ctrlKey,
			bubbles: true,
			cancelable: true
		})
	);
}

/** "+KeyV" for a key down message, "-KeyV" for up; other messages by type. */
function strokes(sent: ViewerMessage[]): string[] {
	return sent.map((message) =>
		message.type === 'key' ? `${message.down ? '+' : '-'}${message.code}` : message.type
	);
}

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

	it("C11: Ctrl+V with clipboard reading granted pushes this device's text, then sends Ctrl+V", async () => {
		vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('copied here');
		const { sent, clipboard, surface, screenKeys, detach } = await picture(true);
		press(surface, 'keydown', 'ControlLeft', true);
		press(surface, 'keydown', 'KeyV', true);
		press(surface, 'keyup', 'KeyV', true);
		await vi.waitFor(() => {
			expect(sent).toEqual([{ type: 'clipboard-push', text: 'copied here' }]);
		});
		// The screen's handler never saw the V: the shortcut sends it after the push.
		expect(screenKeys).toEqual(['+ControlLeft']);
		clipboard.sent();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual(['clipboard-push', '+KeyV', '-KeyV']);
		});
		detach();
	});

	it('C11: Ctrl+V released early still pastes, with Ctrl pressed for it', async () => {
		vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('copied here');
		const { sent, clipboard, surface } = await picture(true);
		press(surface, 'keydown', 'ControlLeft', true);
		press(surface, 'keydown', 'KeyV', true);
		press(surface, 'keyup', 'KeyV', true);
		press(surface, 'keyup', 'ControlLeft', false);
		await vi.waitFor(() => {
			expect(sent).toHaveLength(1);
		});
		clipboard.sent();
		await vi.waitFor(() => {
			expect(strokes(sent)).toEqual([
				'clipboard-push',
				'+ControlLeft',
				'+KeyV',
				'-KeyV',
				'-ControlLeft'
			]);
		});
	});

	it('C11: without the permission, Ctrl+V passes through to the screen untouched', async () => {
		const read = vi.spyOn(navigator.clipboard, 'readText');
		const { sent, surface, screenKeys } = await picture(false);
		press(surface, 'keydown', 'ControlLeft', true);
		press(surface, 'keydown', 'KeyV', true);
		press(surface, 'keyup', 'KeyV', true);
		expect(screenKeys).toEqual(['+ControlLeft', '+KeyV', '-KeyV']);
		expect(sent).toEqual([]);
		expect(read).not.toHaveBeenCalled();
	});

	it('C11: a push the machine does not confirm in time still sends the key', async () => {
		vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('copied here');
		const { sent, surface } = await picture(true);
		press(surface, 'keydown', 'ControlLeft', true);
		press(surface, 'keydown', 'KeyV', true);
		await vi.waitFor(
			() => {
				expect(strokes(sent)).toEqual(['clipboard-push', '+KeyV', '-KeyV']);
			},
			{ timeout: SHORTCUT_PUSH_MS + 1000 }
		);
	});
});
