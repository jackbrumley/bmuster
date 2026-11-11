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
			['tiny', 16],
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

	it('L5: every size is the night radar: dark face, turning beam, four contacts lit in turn', async () => {
		for (const size of ['tiny', 'small', 'medium', 'large'] as const) {
			const screen = await render(RadarSpinner, { size });
			const face = getComputedStyle(radar(screen.container, size));
			expect(face.backgroundColor).toBe('rgb(19, 32, 15)');
			const sweep = part(screen.container, 'sweep');
			expect(sweep.animationName).toContain('radar-sweep');
			expect(sweep.animationDuration).toBe('2.4s');
			const beam = getComputedStyle(
				screen.container.querySelector('.sweep') ?? document.body,
				'::after'
			);
			expect(beam.backgroundColor).toBe('rgb(163, 230, 53)');
			const contacts = [...screen.container.querySelectorAll('.contact')];
			expect(contacts).toHaveLength(4);
			const delays = contacts.map((contact) => getComputedStyle(contact).animationDelay);
			expect(new Set(delays).size).toBe(4);
			for (const contact of contacts) {
				expect(getComputedStyle(contact).animationName).toContain('radar-contact');
			}
			await screen.unmount();
		}
	});

	it('L1: with reduced motion the sweep and blip stop and the radar breathes instead', async () => {
		await commands.emulateReducedMotion(true);
		const screen = await render(RadarSpinner, { size: 'medium' });
		expect(part(screen.container, 'sweep').animationName).toBe('none');
		expect(part(screen.container, 'contact').animationName).toBe('none');
		expect(getComputedStyle(radar(screen.container, 'medium')).animationName).toContain(
			'radar-breathe'
		);
	});
});
