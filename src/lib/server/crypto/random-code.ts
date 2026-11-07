import { randomInt } from 'node:crypto';

/**
 * Codes people read off one screen and type into another (join codes, the
 * first-run setup code). No 0/O, 1/I: easy to read aloud and type.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `length` random characters from the alphabet, without separators. */
export function randomCode(length: number): string {
	return Array.from({ length }, () => CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length))).join(
		''
	);
}

/** What a person typed, as stored: upper case, no spaces or hyphens. */
export function normaliseCode(typed: string): string {
	return typed.toUpperCase().replace(/[\s-]/g, '');
}

/** "ABCDEFGH" in groups of `size`: "ABCD-EFGH". */
export function groupCode(raw: string, size: number): string {
	return raw.match(new RegExp(`.{1,${size}}`, 'g'))?.join('-') ?? raw;
}
