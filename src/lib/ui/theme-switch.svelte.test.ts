import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import appHtml from '../../app.html?raw';
import errorHtml from '../../error.html?raw';
import ThemeSwitch from './theme-switch.svelte';

const KEY = 'bmuster-theme';
const root = document.documentElement;

/** The theme-color metas exactly as app.html renders them. */
function addBarColours(): void {
	const metas = /<meta name="theme-color"[^>]*>/g;
	for (const markup of appHtml.match(metas) ?? []) {
		const holder = document.createElement('template');
		holder.innerHTML = markup;
		const meta = holder.content.firstElementChild;
		if (meta === null) throw new Error('no meta');
		meta.setAttribute('data-test', 'bar');
		document.head.append(meta);
	}
}

function barMedia(scheme: 'light' | 'dark'): string {
	const meta = document.head.querySelector(`meta[data-test="bar"][data-scheme="${scheme}"]`);
	if (!(meta instanceof HTMLMetaElement)) throw new Error(`no ${scheme} theme-color`);
	return meta.media;
}

/** Puts <html> back as the page markup starts it, then runs that page's start-up script. */
function startPage(html: string): void {
	const start = /<html ([^>]*)>/.exec(html);
	const theme = start === null ? null : /data-theme="([a-z]+)"/.exec(start[1] ?? '');
	if (theme === null) throw new Error('the page sets no data-theme on <html>');
	root.dataset['theme'] = theme[1];
	const source = /<script>([\s\S]*?)<\/script>/.exec(html);
	if (source === null) throw new Error('no start-up script');
	const script = document.createElement('script');
	script.textContent = source[1] ?? '';
	document.head.append(script);
	script.remove();
}

beforeEach(() => {
	localStorage.clear();
	addBarColours();
});

afterEach(() => {
	localStorage.clear();
	delete root.dataset['theme'];
	for (const meta of document.head.querySelectorAll('meta[data-test="bar"]')) meta.remove();
});

describe('start-up theme (SPEC-BRAND-ICON T1, T2)', () => {
	it('T1: a new visitor gets light before first paint, with a light browser bar', () => {
		startPage(appHtml);
		expect(root.dataset['theme']).toBe('light');
		expect(barMedia('light')).toBe('all');
		expect(barMedia('dark')).toBe('not all');
	});

	it('T2: a saved dark or light choice is applied', () => {
		localStorage.setItem(KEY, 'dark');
		startPage(appHtml);
		expect(root.dataset['theme']).toBe('dark');
		expect(barMedia('dark')).toBe('all');
		expect(barMedia('light')).toBe('not all');
		localStorage.setItem(KEY, 'light');
		startPage(appHtml);
		expect(root.dataset['theme']).toBe('light');
	});

	it('T2: a saved system choice follows the device', () => {
		localStorage.setItem(KEY, 'system');
		startPage(appHtml);
		expect(root.dataset['theme']).toBeUndefined();
		expect(barMedia('light')).toBe('(prefers-color-scheme: light)');
		expect(barMedia('dark')).toBe('(prefers-color-scheme: dark)');
	});

	it('T2: an unknown saved value falls back to the light default', () => {
		localStorage.setItem(KEY, 'sepia');
		startPage(appHtml);
		expect(root.dataset['theme']).toBe('light');
	});

	it('T5: the last-resort error page starts light and honours the same choices', () => {
		startPage(errorHtml);
		expect(root.dataset['theme']).toBe('light');
		localStorage.setItem(KEY, 'dark');
		startPage(errorHtml);
		expect(root.dataset['theme']).toBe('dark');
		localStorage.setItem(KEY, 'system');
		startPage(errorHtml);
		expect(root.dataset['theme']).toBeUndefined();
	});
});

describe('ThemeSwitch (SPEC-BRAND-ICON T3, T4)', () => {
	function pressed(container: HTMLElement): string | null {
		return (
			container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label') ?? null
		);
	}

	it('T3: shows Light for a new visitor', async () => {
		startPage(appHtml);
		const screen = await render(ThemeSwitch, {});
		await expect
			.element(screen.getByRole('button', { name: 'Light' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('T4: stores each choice and the next page load restores it', async () => {
		startPage(appHtml);
		const screen = await render(ThemeSwitch, {});

		await screen.getByRole('button', { name: 'System' }).click();
		expect(localStorage.getItem(KEY)).toBe('system');
		expect(root.dataset['theme']).toBeUndefined();
		expect(barMedia('dark')).toBe('(prefers-color-scheme: dark)');

		await screen.getByRole('button', { name: 'Dark' }).click();
		expect(localStorage.getItem(KEY)).toBe('dark');
		expect(root.dataset['theme']).toBe('dark');
		expect(barMedia('dark')).toBe('all');

		await screen.getByRole('button', { name: 'Light' }).click();
		expect(localStorage.getItem(KEY)).toBe('light');
		expect(root.dataset['theme']).toBe('light');
		expect(barMedia('light')).toBe('all');
		await screen.unmount();

		for (const [saved, label] of [
			['system', 'System'],
			['dark', 'Dark'],
			['light', 'Light']
		] as const) {
			localStorage.setItem(KEY, saved);
			startPage(appHtml);
			const again = await render(ThemeSwitch, {});
			await expect.poll(() => pressed(again.container)).toBe(label);
			await again.unmount();
		}
	});
});
