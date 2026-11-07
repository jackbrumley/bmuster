/**
 * HTTP byte ranges for downloads (SPEC-FILES F5; RFC 9110 section 14), so a
 * browser's download manager can resume. One range only: a request for
 * several gets the whole file, which the RFC allows.
 */

export type ByteRange =
	| { kind: 'whole' }
	/** Inclusive, as `Content-Range` writes it. */
	| { kind: 'part'; start: number; end: number }
	| { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** The range a `Range` header asks for in a file of `size` bytes. */
export function parseRange(header: string | null, size: number): ByteRange {
	if (header === null) {
		return { kind: 'whole' };
	}
	const match = SINGLE_RANGE.exec(header.trim());
	const first = match?.[1] ?? '';
	const last = match?.[2] ?? '';
	if (match === null || (first === '' && last === '')) {
		// Not one range we understand: the RFC says to ignore the header.
		return { kind: 'whole' };
	}
	if (first === '') {
		const suffix = Number(last);
		if (suffix === 0 || size === 0) {
			return { kind: 'unsatisfiable' };
		}
		return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	if (start >= size) {
		return { kind: 'unsatisfiable' };
	}
	if (last === '') {
		return { kind: 'part', start, end: size - 1 };
	}
	const end = Number(last);
	if (end < start) {
		return { kind: 'whole' };
	}
	return { kind: 'part', start, end: Math.min(end, size - 1) };
}

/**
 * Whether an `If-Range` validator still names this version of the file:
 * an ETag must match exactly (a weak one never does), a date must equal
 * `Last-Modified`. Without the header the range always applies.
 */
export function rangeStillValid(
	ifRange: string | null,
	current: { etag: string; lastModified: string }
): boolean {
	if (ifRange === null) {
		return true;
	}
	const validator = ifRange.trim();
	if (validator.startsWith('"') || validator.startsWith('W/')) {
		return validator === current.etag;
	}
	return validator === current.lastModified;
}
