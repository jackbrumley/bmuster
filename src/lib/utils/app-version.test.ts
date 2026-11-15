import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fullLoadTarget, mayReload, staleCode, VERSION_POLL_MS } from './app-version.ts';

// SPEC-SERVER-UPDATES SU17–SU19: open tabs after a server update.

/** A stand-in for sessionStorage. */
function memory(): Pick<Storage, 'getItem' | 'setItem'> {
	const items = new Map<string, string>();
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, value);
		}
	};
}

describe('open tabs after a server update', () => {
	it('SU17: the client looks for a new version every minute', () => {
		expect(VERSION_POLL_MS).toBe(60_000);
		const config = readFileSync('vite.config.ts', 'utf8');
		expect(config).toMatch(/version:\s*\{\s*pollInterval:\s*VERSION_POLL_MS\s*\}/);
	});

	it('SU18: once a new version is known, the next navigation loads the whole page', () => {
		const to = { url: new URL('https://bmuster.test/machines') };
		expect(fullLoadTarget({ willUnload: false, to }, true)).toEqual(to.url);
		expect(fullLoadTarget({ willUnload: false, to }, false)).toBeUndefined();
		// The browser already loads the whole page, or there is nowhere to go.
		expect(fullLoadTarget({ willUnload: true, to }, true)).toBeUndefined();
		expect(fullLoadTarget({ willUnload: false, to: null }, true)).toBeUndefined();
	});

	it('SU19: code that is no longer on the server is told apart from other errors', () => {
		for (const message of [
			'Failed to fetch dynamically imported module: https://bmuster.test/_app/immutable/nodes/4.abc.js',
			'Importing a module script failed.',
			'error loading dynamically imported module: https://bmuster.test/_app/immutable/nodes/4.abc.js',
			'Unable to preload CSS for /_app/immutable/assets/4.abc.css'
		]) {
			expect(staleCode(new TypeError(message))).toBe(true);
		}
		expect(staleCode(new Error('Cannot read properties of undefined'))).toBe(false);
		expect(staleCode('Failed to fetch dynamically imported module')).toBe(false);
	});

	it('SU19: reloads a page once, so code that never loads cannot loop', () => {
		const storage = memory();
		const url = new URL('https://bmuster.test/machines');
		expect(mayReload(url, 1_000, storage)).toBe(true);
		expect(mayReload(url, 2_000, storage)).toBe(false);
		expect(mayReload(url, 1_000 + 30_000, storage)).toBe(true);
		expect(mayReload(new URL('https://bmuster.test/users'), 31_500, storage)).toBe(true);
	});

	it('SU19: blocked storage still reloads', () => {
		const blocked: Pick<Storage, 'getItem' | 'setItem'> = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		};
		expect(mayReload(new URL('https://bmuster.test/'), 1, blocked)).toBe(true);
	});
});
