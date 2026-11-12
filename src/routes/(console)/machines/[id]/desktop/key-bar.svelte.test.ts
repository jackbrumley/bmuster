import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import '#lib/ui/design-tokens.css';
import KeyBar from './key-bar.svelte';

// SPEC-DESKTOP 21.11: C39.

async function setup() {
	const sent: InputMessage[] = [];
	const onpaste = vi.fn();
	const screen = await render(KeyBar, {
		osFamily: 'windows',
		send: (message: InputMessage) => {
			sent.push(message);
		},
		onkeyboard: undefined,
		onpaste
	});
	const typing = screen.getByRole('textbox', { name: 'Type on the machine' }).element();
	return { sent, onpaste, typing };
}

function input(typing: Element, init: InputEventInit) {
	typing.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...init }));
}

describe('the phone keyboard and the clipboard', () => {
	it('C39: a paste goes to the clipboard, not typed; typing stays typing', async () => {
		const { sent, onpaste, typing } = await setup();
		const pasted = new DataTransfer();
		pasted.setData('text/plain', 'a long line from my phone');
		input(typing, { inputType: 'insertFromPaste', dataTransfer: pasted });
		expect(onpaste).toHaveBeenCalledWith('a long line from my phone');
		expect(sent).toEqual([]);
		input(typing, { inputType: 'insertText', data: 'hello world' });
		expect(sent).toEqual([{ type: 'text', text: 'hello world' }]);
		expect(onpaste).toHaveBeenCalledTimes(1);
	});

	it('C39: a composed word is typed when the composition ends, and the box is emptied', async () => {
		const { sent, typing } = await setup();
		input(typing, { inputType: 'insertCompositionText', data: 'wor' });
		expect(sent).toEqual([]);
		typing.append('word');
		typing.dispatchEvent(new Event('input', { bubbles: true }));
		typing.dispatchEvent(new CompositionEvent('compositionend', { data: 'word', bubbles: true }));
		expect(sent).toEqual([{ type: 'text', text: 'word' }]);
		await expect.poll(() => typing.textContent).toBe('');
	});

	it('C39: a long composition goes in pieces the agent takes', async () => {
		const { sent, typing } = await setup();
		const long = 'é'.repeat(300);
		typing.dispatchEvent(new CompositionEvent('compositionend', { data: long, bubbles: true }));
		expect(sent).toEqual([
			{ type: 'text', text: 'é'.repeat(256) },
			{ type: 'text', text: 'é'.repeat(44) }
		]);
	});
});
