import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { MAX_CLIPBOARD_BYTES, type ViewerMessage } from '#lib/domain/desktop/messages.ts';
import '#lib/ui/design-tokens.css';
import ClipboardPanel from './clipboard-panel.svelte';
import { DesktopClipboard } from './clipboard.svelte.ts';

// SPEC-DESKTOP 21: C8, C9.

async function setup(text = '') {
	const sent: ViewerMessage[] = [];
	const clipboard = new DesktopClipboard((message) => {
		sent.push(message);
	});
	clipboard.text = text;
	const screen = await render(ClipboardPanel, { clipboard });
	const panel = screen.getByRole('region', { name: 'Clipboard' });
	const box = panel.getByRole('textbox', { name: 'Text' });
	return { sent, clipboard, panel, box };
}

describe('the clipboard panel', () => {
	it('C8: Get from machine sends clipboard-pull and fills the box from the reply', async () => {
		const { sent, clipboard, panel, box } = await setup();
		await panel.getByRole('button', { name: 'Get from machine' }).click();
		expect(sent).toEqual([{ type: 'clipboard-pull' }]);
		clipboard.received('ERROR 0x80070005\naccess denied');
		await expect.element(box).toHaveValue('ERROR 0x80070005\naccess denied');
		await expect
			.element(panel.getByRole('status'))
			.toHaveTextContent("Got the machine's clipboard.");
	});

	it("C8: Send to machine sends the box's text and shows the agent's confirmation", async () => {
		const { sent, clipboard, panel, box } = await setup();
		await box.fill('licence key ABCD-1234');
		await panel.getByRole('button', { name: 'Send to machine' }).click();
		expect(sent).toEqual([{ type: 'clipboard-push', text: 'licence key ABCD-1234' }]);
		clipboard.sent();
		await expect
			.element(panel.getByRole('status'))
			.toHaveTextContent("Sent to the machine's clipboard.");
	});

	it('C8: an error from the agent shows in the panel', async () => {
		const { clipboard, panel } = await setup();
		await panel.getByRole('button', { name: 'Get from machine' }).click();
		clipboard.failed('Copy and paste is not available on this screen.');
		await expect
			.element(panel.getByRole('alert'))
			.toHaveTextContent('Copy and paste is not available on this screen.');
	});

	it('C9: text over 1 MiB is refused with a field error and nothing is sent', async () => {
		// Two bytes a character in UTF-8: half as many characters is already too many bytes.
		const { sent, panel } = await setup('é'.repeat(MAX_CLIPBOARD_BYTES / 2 + 1));
		await expect.element(panel.getByText(/The text is over 1 MB/)).toBeVisible();
		await panel.getByRole('button', { name: 'Send to machine' }).click();
		expect(sent).toEqual([]);
	});

	it("C9: Copy puts the box on this device's clipboard", async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		const { panel } = await setup('copy me');
		await panel.getByRole('button', { name: 'Copy' }).click();
		expect(write).toHaveBeenCalledWith('copy me');
		await expect.element(panel.getByRole('status')).toHaveTextContent('Copied to this device.');
	});

	it('C9: Paste from this device fills the box, or explains when the browser refuses', async () => {
		const read = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('from my laptop');
		const { panel, box } = await setup();
		await panel.getByRole('button', { name: 'Paste from this device' }).click();
		await expect.element(box).toHaveValue('from my laptop');

		read.mockRejectedValue(new DOMException('Read permission denied.', 'NotAllowedError'));
		await panel.getByRole('button', { name: 'Paste from this device' }).click();
		await expect
			.element(panel.getByRole('alert'))
			.toHaveTextContent(
				'This browser did not allow reading its clipboard. Paste into the box with your keys instead.'
			);
		await expect.element(box).toHaveValue('from my laptop');
	});
});
