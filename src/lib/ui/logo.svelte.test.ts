import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Logo from './logo.svelte';
import './design-tokens.css';

function image(container: HTMLElement): HTMLImageElement {
	const element = container.querySelector('img');
	if (!(element instanceof HTMLImageElement)) throw new Error('no logo image');
	return element;
}

afterEach(() => {
	delete document.documentElement.dataset['theme'];
});

describe('Logo (SPEC-BRAND-ICON I4)', () => {
	it('I4: draws the one mark at every size', async () => {
		const small = await render(Logo, { size: 32 });
		const full = await render(Logo, { size: 48 });
		expect(image(small.container).getAttribute('src')).toMatch(/\/brand\/bmuster-logo\.svg$/);
		expect(image(full.container).getAttribute('src')).toMatch(/\/brand\/bmuster-logo\.svg$/);
		expect(image(small.container).alt).toBe('');
	});

	for (const [theme, width] of [
		['light', 390],
		['dark', 390],
		['light', 1280],
		['dark', 1280]
	] as const) {
		it(`I4: keeps its size in ${theme} at ${String(width)}px`, async () => {
			await page.viewport(width, 800);
			document.documentElement.dataset['theme'] = theme;
			for (const size of [32, 48]) {
				const screen = await render(Logo, { size });
				const box = image(screen.container).getBoundingClientRect();
				expect([box.width, box.height]).toEqual([size, size]);
				await screen.unmount();
			}
		});
	}
});
