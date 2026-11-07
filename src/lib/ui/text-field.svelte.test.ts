/**
 * iOS zooms the page when a text box under 16px is focused (AGENTS.md §4).
 * Hygiene rule input-font-size-ios-zoom reads the CSS; this checks what the
 * browser actually computes, with the global stylesheet loaded.
 */
import '../../app.css';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TextField from './text-field.svelte';

function fontSizePx(element: Element | null): number {
	if (element === null) throw new Error('no text box');
	return Number.parseFloat(getComputedStyle(element).fontSize);
}

describe('text boxes are at least 16px', () => {
	it('TextField, single line and multiline, under its smaller label text', async () => {
		for (const type of ['text', 'multiline'] as const) {
			const screen = await render(TextField, {
				label: 'Name',
				name: 'name',
				type,
				autocomplete: 'off',
				autocapitalize: 'off',
				required: false,
				error: undefined,
				value: ''
			});
			const box = screen.container.querySelector('input, textarea');
			expect(fontSizePx(box)).toBeGreaterThanOrEqual(16);
			expect(fontSizePx(screen.container.querySelector('.field'))).toBeLessThan(16);
			await screen.unmount();
		}
	});

	it('a text box no component sizes, inside small text, gets the 16px base', () => {
		const parent = document.createElement('div');
		parent.style.fontSize = '12px';
		parent.innerHTML =
			'<input type="search"><textarea></textarea><select><option>One</option></select><div contenteditable="true"></div>';
		document.body.append(parent);
		try {
			for (const box of parent.querySelectorAll('input, textarea, select, [contenteditable]')) {
				expect(fontSizePx(box), box.tagName).toBeGreaterThanOrEqual(16);
			}
		} finally {
			parent.remove();
		}
	});
});
