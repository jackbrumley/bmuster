import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import RadarSpinner from './radar-spinner.svelte';
// The real tokens, so the radar's colours and rings resolve as they do in the console.
import './design-tokens.css';

declare module 'vitest/browser' {
	interface BrowserCommands {
		emulateReducedMotion: (reduce: boolean) => Promise<void>;
	}
}

function radar(container: HTMLElement, size: string): HTMLElement {
	const element = container.querySelector(`[data-radar="${size}"]`);
	if (!(element instanceof HTMLElement)) throw new Error(`no ${size} radar`);
	return element;
}

function part(container: HTMLElement, name: string): CSSStyleDeclaration {
	const element = container.querySelector(`.${name}`);
	if (element === null) throw new Error(`no ${name}`);
	return getComputedStyle(element);
}

afterEach(async () => {
	await commands.emulateReducedMotion(false);
});

describe('RadarSpinner (SPEC-LOADING L1)', () => {
	it('L1: renders each size, hidden from screen readers', async () => {
		for (const [size, pixels] of [
			['small', 24],
			['medium', 48],
			['large', 96]
		] as const) {
			const screen = await render(RadarSpinner, { size });
			const element = radar(screen.container, size);
			const box = element.getBoundingClientRect();
			expect(box.width).toBe(pixels);
			expect(box.height).toBe(pixels);
			expect(element.getAttribute('aria-hidden')).toBe('true');
			await screen.unmount();
		}
	});

	it('L1: the sweep turns once every 2.4 s over faint rings, with a blip', async () => {
		const screen = await render(RadarSpinner, { size: 'large' });
		const sweep = part(screen.container, 'sweep');
		expect(sweep.animationName).toContain('radar-sweep');
		expect(sweep.animationDuration).toBe('2.4s');
		expect(sweep.backgroundImage).toContain('conic-gradient');
		expect(part(screen.container, 'blip').animationName).toContain('radar-blip');
		expect(part(screen.container, 'outer').borderTopStyle).toBe('solid');
	});

	it('L1: with reduced motion the sweep and blip stop and the radar breathes instead', async () => {
		await commands.emulateReducedMotion(true);
		const screen = await render(RadarSpinner, { size: 'medium' });
		expect(part(screen.container, 'sweep').animationName).toBe('none');
		expect(part(screen.container, 'blip').animationName).toBe('none');
		expect(getComputedStyle(radar(screen.container, 'medium')).animationName).toContain(
			'radar-breathe'
		);
	});
});
