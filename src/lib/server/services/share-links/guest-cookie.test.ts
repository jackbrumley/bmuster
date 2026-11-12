import { describe, expect, it } from 'vitest';
import { guestCookieMatches, guestCookieOptions, guestCookieValue } from './guest-cookie.ts';

const KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 8);
const LINK = '6f1c2b8e-1d9a-4c3e-9b2a-0f5e7d6c4b3a';
const OTHER_LINK = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = 1_794_000_000_000;

describe('the guest cookie (SPEC-SHARE-LINKS D4)', () => {
	it('SL10: matches only its own link, made by this server, before it runs out', () => {
		const value = guestCookieValue(KEY, LINK, NOW + 60_000);
		expect(guestCookieMatches(KEY, value, LINK, NOW)).toBe(true);
		expect(guestCookieMatches(KEY, value, OTHER_LINK, NOW)).toBe(false);
		expect(guestCookieMatches(OTHER_KEY, value, LINK, NOW)).toBe(false);
		expect(guestCookieMatches(KEY, value, LINK, NOW + 60_000)).toBe(false);
		expect(guestCookieMatches(KEY, undefined, LINK, NOW)).toBe(false);
	});

	it('SL10: a changed expiry, id or signature is refused', () => {
		const value = guestCookieValue(KEY, LINK, NOW + 60_000);
		const [id, expires, mac] = value.split('.');
		const tampered = [
			`${id ?? ''}.${String(NOW + 10 * 60_000)}.${mac ?? ''}`,
			`${OTHER_LINK}.${expires ?? ''}.${mac ?? ''}`,
			`${id ?? ''}.${expires ?? ''}.${(mac ?? '').slice(0, -2)}AA`,
			`${id ?? ''}.${expires ?? ''}`,
			`${value}.extra`,
			`${id ?? ''}.1e20.${mac ?? ''}`,
			''
		];
		for (const attempt of tampered) {
			expect(guestCookieMatches(KEY, attempt, LINK, NOW)).toBe(false);
		}
	});

	it('is scoped to the link, HttpOnly, Secure, SameSite=Strict and never outlives the link', () => {
		expect(guestCookieOptions('/s/abc', NOW + 90_500, NOW)).toEqual({
			path: '/s/abc',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 91
		});
	});
});
