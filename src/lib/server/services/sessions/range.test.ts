import { describe, expect, it } from 'vitest';
import { parseRange, rangeStillValid } from './range.ts';

describe('Range headers for resumable downloads (SPEC-FILES F5)', () => {
	it('gives the whole file without a header or with one it does not understand', () => {
		expect(parseRange(null, 100)).toEqual({ kind: 'whole' });
		expect(parseRange('bytes=0-9,20-29', 100)).toEqual({ kind: 'whole' });
		expect(parseRange('lines=1-2', 100)).toEqual({ kind: 'whole' });
		expect(parseRange('bytes=-', 100)).toEqual({ kind: 'whole' });
		expect(parseRange('bytes=50-10', 100)).toEqual({ kind: 'whole' });
	});

	it('reads from an offset to the end, a closed range, and a suffix', () => {
		expect(parseRange('bytes=40-', 100)).toEqual({ kind: 'part', start: 40, end: 99 });
		expect(parseRange('bytes=0-0', 100)).toEqual({ kind: 'part', start: 0, end: 0 });
		expect(parseRange('bytes=10-19', 100)).toEqual({ kind: 'part', start: 10, end: 19 });
		expect(parseRange('bytes=90-500', 100)).toEqual({ kind: 'part', start: 90, end: 99 });
		expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'part', start: 90, end: 99 });
		expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'part', start: 0, end: 99 });
		expect(parseRange(' bytes=5-6 ', 100)).toEqual({ kind: 'part', start: 5, end: 6 });
	});

	it('cannot satisfy a range past the end, an empty suffix or any range of an empty file', () => {
		expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
		expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
		expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
	});

	it('honours If-Range only when it still names this version of the file', () => {
		const current = { etag: '"a-b"', lastModified: 'Sat, 07 Nov 2026 00:00:00 GMT' };
		expect(rangeStillValid(null, current)).toBe(true);
		expect(rangeStillValid('"a-b"', current)).toBe(true);
		expect(rangeStillValid('"a-c"', current)).toBe(false);
		expect(rangeStillValid('W/"a-b"', current)).toBe(false);
		expect(rangeStillValid('Sat, 07 Nov 2026 00:00:00 GMT', current)).toBe(true);
		expect(rangeStillValid('Fri, 06 Nov 2026 00:00:00 GMT', current)).toBe(false);
	});
});
