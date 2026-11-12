import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerMessage } from '#lib/domain/desktop/messages.ts';
import { toasts } from '#lib/ui/toast.svelte.ts';
import {
	attachClipboardSharing,
	COPIED_FROM_MACHINE,
	DesktopClipboard,
	READY_TO_PASTE
} from './clipboard.svelte.ts';

// SPEC-DESKTOP 21.11: C35, C36, C37, C38.

afterEach(() => {
	toasts.list = [];
});

/** Whether the browser says the page may read the clipboard: a real status with its state set. */
async function permission(granted: boolean) {
	const status = await navigator.permissions.query({ name: 'geolocation' });
	Object.defineProperty(status, 'state', {
		value: granted ? 'granted' : 'prompt',
		configurable: true
	});
	return vi.spyOn(navigator.permissions, 'query').mockResolvedValue(status);
}

/** A clipboard in a running control session, with what it sent after `clipboard-share`. */
async function live(granted: boolean) {
	await permission(granted);
	const sent: ViewerMessage[] = [];
	const clipboard = new DesktopClipboard((message) => {
		sent.push(message);
	});
	clipboard.started();
	await vi.waitFor(() => {
		expect(clipboard.readAllowed).toBe(granted);
	});
	return { sent, clipboard };
}

describe('clipboard sharing (SPEC-DESKTOP 21.11)', () => {
	it('C35: the session starts with sharing on, and the switch tells the agent', async () => {
		const { sent, clipboard } = await live(false);
		expect(sent).toEqual([{ type: 'clipboard-share', on: true }]);
		clipboard.sharing = false;
		clipboard.sharing = true;
		expect(sent.slice(1)).toEqual([
			{ type: 'clipboard-share', on: false },
			{ type: 'clipboard-share', on: true }
		]);
		// Before a control session starts nothing is sent (a watch-only viewer never sends it).
		const quiet: ViewerMessage[] = [];
		const watching = new DesktopClipboard((message) => {
			quiet.push(message);
		});
		watching.sharing = false;
		expect(quiet).toEqual([]);
	});

	it('C35: a machine copy is written to this device at once when the page has focus', async () => {
		const { clipboard } = await live(false);
		vi.spyOn(document, 'hasFocus').mockReturnValue(true);
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		await clipboard.changed('copied at the machine');
		expect(write).toHaveBeenCalledWith('copied at the machine');
		expect(clipboard.pending).toBeUndefined();
		expect(clipboard.latest).toBe('copied at the machine');
	});

	it('C35: refused, it waits for the next tap or key in the page, then lands with a toast', async () => {
		const { clipboard } = await live(false);
		vi.spyOn(document, 'hasFocus').mockReturnValue(true);
		const write = vi
			.spyOn(navigator.clipboard, 'writeText')
			.mockRejectedValueOnce(new DOMException('Document is not focused.', 'NotAllowedError'))
			.mockResolvedValue(undefined);
		await clipboard.changed('needs a tap');
		expect(clipboard.pending).toBe('needs a tap');
		const detach = attachClipboardSharing(clipboard);
		window.dispatchEvent(new PointerEvent('pointerdown'));
		await vi.waitFor(() => {
			expect(clipboard.pending).toBeUndefined();
		});
		expect(write).toHaveBeenLastCalledWith('needs a tap');
		expect(toasts.list.map((toast) => toast.message)).toEqual([COPIED_FROM_MACHINE]);
		detach();
	});

	it('C35: with sharing off a machine copy is ignored', async () => {
		const { clipboard } = await live(false);
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		clipboard.sharing = false;
		await clipboard.changed('not wanted');
		expect(write).not.toHaveBeenCalled();
		expect(clipboard.pending).toBeUndefined();
		expect(clipboard.latest).toBe('');
	});

	it('C36: on focus, with reading allowed, new device text goes to the machine once', async () => {
		const { sent, clipboard } = await live(true);
		const read = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('copied on my laptop');
		const detach = attachClipboardSharing(clipboard);
		window.dispatchEvent(new FocusEvent('focus'));
		await vi.waitFor(() => {
			expect(sent).toContainEqual({ type: 'clipboard-sync', text: 'copied on my laptop' });
		});
		window.dispatchEvent(new FocusEvent('focus'));
		await vi.waitFor(() => {
			expect(read).toHaveBeenCalledTimes(2);
		});
		expect(sent.filter((message) => message.type === 'clipboard-sync')).toHaveLength(1);
		// Text that came from the machine is not sent back.
		vi.spyOn(document, 'hasFocus').mockReturnValue(false);
		await clipboard.changed('from the machine');
		read.mockResolvedValue('from the machine');
		await clipboard.syncFromDevice();
		expect(sent.filter((message) => message.type === 'clipboard-sync')).toHaveLength(1);
		detach();
	});

	it('C36: without the permission focus never reads the clipboard, so never prompts', async () => {
		const { sent, clipboard } = await live(false);
		const read = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('secret');
		await clipboard.syncFromDevice();
		expect(read).not.toHaveBeenCalled();
		expect(sent).toEqual([{ type: 'clipboard-share', on: true }]);
	});

	it('C37: Allow clipboard sharing reads once on the press and sends the text', async () => {
		const { sent, clipboard } = await live(false);
		vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('first copy');
		await permission(true);
		await clipboard.allowSharing();
		expect(clipboard.readAllowed).toBe(true);
		expect(sent).toContainEqual({ type: 'clipboard-sync', text: 'first copy' });
	});

	it('C38: a paste from the phone keyboard is pushed, not typed, and says it is ready', async () => {
		const { sent, clipboard } = await live(false);
		clipboard.pasteFromKeyboard('pasted from my phone');
		expect(sent).toContainEqual({ type: 'clipboard-push', text: 'pasted from my phone' });
		clipboard.sent();
		expect(toasts.list.map((toast) => toast.message)).toEqual([READY_TO_PASTE]);
	});
});
