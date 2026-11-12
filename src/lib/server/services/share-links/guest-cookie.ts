import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * The guest cookie (SPEC-SHARE-LINKS D4). Loading `/s/<token>` sets it; every
 * guest API request needs it as well as the token, for the same link. It is
 * stateless: an HMAC-SHA256 over the link id and an expiry, with a key
 * derived from SECRETS_KEY, so a server restart keeps guests connected and
 * nothing about guests is stored. Scoped to `/s/<token>`, HttpOnly, Secure,
 * SameSite=Strict, and never longer-lived than the link.
 */
export const GUEST_COOKIE = 'bmuster_guest';

/** The key for guest cookies only, so it is useless for anything else SECRETS_KEY protects. */
function cookieKey(secretsKey: Buffer): Buffer {
	return Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'bmuster guest cookie 1', 32));
}

function macOf(secretsKey: Buffer, linkId: string, expiresMs: number): string {
	return createHmac('sha256', cookieKey(secretsKey))
		.update(`${linkId}.${String(expiresMs)}`, 'utf8')
		.digest('base64url');
}

/** `<link id>.<expiry ms>.<mac>`. */
export function guestCookieValue(secretsKey: Buffer, linkId: string, expiresMs: number): string {
	return `${linkId}.${String(expiresMs)}.${macOf(secretsKey, linkId, expiresMs)}`;
}

/** True when the cookie was made by this server, for this link, and has not run out. */
export function guestCookieMatches(
	secretsKey: Buffer,
	value: string | undefined,
	linkId: string,
	now: number
): boolean {
	if (value === undefined) {
		return false;
	}
	const [id, expiresText, mac, ...rest] = value.split('.');
	if (id === undefined || expiresText === undefined || mac === undefined || rest.length > 0) {
		return false;
	}
	if (!/^\d{1,15}$/.test(expiresText)) {
		return false;
	}
	const expiresMs = Number(expiresText);
	const wanted = Buffer.from(macOf(secretsKey, id, expiresMs), 'utf8');
	const given = Buffer.from(mac, 'utf8');
	const signed = wanted.length === given.length && timingSafeEqual(wanted, given);
	return signed && id === linkId && expiresMs > now;
}

export type GuestCookieOptions = {
	path: string;
	httpOnly: true;
	secure: true;
	sameSite: 'strict';
	maxAge: number;
};

/** Sent only to this link's own pages, and gone when the link ends. */
export function guestCookieOptions(
	linkPath: string,
	expiresMs: number,
	now: number
): GuestCookieOptions {
	return {
		path: linkPath,
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: Math.max(1, Math.ceil((expiresMs - now) / 1000))
	};
}
