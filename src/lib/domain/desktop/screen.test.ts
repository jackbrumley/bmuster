import { describe, expect, it } from 'vitest';
import { screenLabel } from './screen.ts';

// SPEC-DESKTOP 15, following the screen: the Desktop tab's status line.

describe('screenLabel', () => {
	it('names the sign-in screen, the desktop and its user, and a locked desktop', () => {
		expect(screenLabel({ kind: 'sign-in' })).toBe('Sign-in screen');
		expect(screenLabel({ kind: 'desktop', user: 'jack' })).toBe("jack's desktop");
		expect(screenLabel({ kind: 'locked', user: 'jack' })).toBe("jack's desktop · locked");
		expect(screenLabel({ kind: 'desktop', user: null })).toBe('Desktop');
		expect(screenLabel({ kind: 'locked', user: null })).toBe('Desktop · locked');
	});

	it('says why there is no screen', () => {
		expect(screenLabel({ kind: 'unavailable', reason: 'Text console' })).toBe(
			'Screen not available: Text console'
		);
	});
});
