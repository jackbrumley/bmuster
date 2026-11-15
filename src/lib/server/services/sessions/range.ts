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

/** `attachment` with an ASCII fallback name and the real one (RFC 6266). */
export function attachment(name: string): string {
	const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** What to send for one file: nothing (416), or a status and the bytes from `start`. */
export type RangePlan =
	{ kind: 'unsatisfiable' } | { kind: 'send'; status: 200 | 206; start: number; length: number };

/**
 * A single file's download headers (SPEC-FILES F5, SPEC-SESSION-FILES SF25): Content-Length,
 * Accept-Ranges, ETag, Last-Modified and Content-Disposition, the range asked for (dropped when
 * If-Range names an older version) and Content-Range.
 */
export function fileDownload(
	file: { name: string; size: number; modifiedMs: number },
	asked: { range: string | null; ifRange: string | null }
): { headers: Headers; plan: RangePlan } {
	const { size, modifiedMs } = file;
	const etag = `"${size.toString(36)}-${modifiedMs.toString(36)}"`;
	const lastModified = new Date(modifiedMs).toUTCString();
	const range: ByteRange = rangeStillValid(asked.ifRange, { etag, lastModified })
		? parseRange(asked.range, size)
		: { kind: 'whole' };
	const headers = new Headers({
		'accept-ranges': 'bytes',
		'cache-control': 'no-store',
		'content-disposition': attachment(file.name),
		'content-type': 'application/octet-stream',
		etag,
		'last-modified': lastModified,
		'x-content-type-options': 'nosniff'
	});
	if (range.kind === 'unsatisfiable') {
		headers.set('content-range', `bytes */${size}`);
		return { headers, plan: { kind: 'unsatisfiable' } };
	}
	const start = range.kind === 'part' ? range.start : 0;
	const length = range.kind === 'part' ? range.end - range.start + 1 : size;
	headers.set('content-length', String(length));
	if (range.kind === 'part') {
		headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
	}
	return {
		headers,
		plan: { kind: 'send', status: range.kind === 'part' ? 206 : 200, start, length }
	};
}
