import { describe, expect, it } from 'vitest';
import { copiedLabel, downloadLabel, type OfferItem } from './session-files.ts';

// SPEC-DESKTOP 23 (DP4): what the Download button and the files-waiting notice say.

const REPORT: OfferItem = { name: 'report.pdf', kind: 'file', size: 10 };
const PHOTOS: OfferItem = { name: 'Photos', kind: 'folder', size: 0 };

describe('the copied files labels', () => {
	it('DP4: one file downloads as itself; a folder or several items say they come as a zip', () => {
		expect(downloadLabel({ items: [REPORT], count: 1 })).toBe('Download report.pdf');
		expect(downloadLabel({ items: [PHOTOS], count: 1 })).toBe('Download Photos (zip)');
		expect(downloadLabel({ items: [REPORT, PHOTOS], count: 2 })).toBe('Download 2 files (zip)');
		expect(downloadLabel({ items: [REPORT, REPORT, REPORT], count: 3 })).toBe(
			'Download 3 files (zip)'
		);
	});

	it('DP3: the notice names one item, or counts several', () => {
		expect(copiedLabel({ items: [REPORT], count: 1 })).toBe('report.pdf copied on the machine');
		expect(copiedLabel({ items: [PHOTOS], count: 1 })).toBe('Photos copied on the machine');
		expect(copiedLabel({ items: [REPORT, PHOTOS], count: 2 })).toBe(
			'2 files copied on the machine'
		);
	});
});
