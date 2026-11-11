import { describe, expect, it } from 'vitest';
import { activityLabel } from '../activity/activity.ts';
import {
	cleanupAuditDetail,
	cleanupStartDetail,
	confirmText,
	resultText,
	selectionText,
	sizeText,
	type CleanupItemId,
	type CleanupItemProgress,
	type CleanupItemSize
} from './cleanup.ts';

const GB = 1024 ** 3;

const SIZES: CleanupItemSize[] = [
	{ id: 'old-var-tmp', size: { kind: 'bytes', bytes: 2 * GB, files: 4210 } },
	{ id: 'journal', size: { kind: 'bytes', bytes: 0, files: 0 } },
	{ id: 'unused-flatpaks', size: { kind: 'unknown' } }
];

const DONE: CleanupItemProgress[] = [
	{
		id: 'old-var-tmp',
		state: {
			kind: 'done',
			result: {
				freedBytes: GB,
				measured: 'counted',
				filesRemoved: 4100,
				filesSkipped: 110,
				errors: 0,
				messages: []
			}
		}
	},
	{
		id: 'unused-flatpaks',
		state: {
			kind: 'done',
			result: {
				freedBytes: GB / 2,
				measured: 'free-space',
				filesRemoved: 0,
				filesSkipped: 0,
				errors: 1,
				messages: ['flatpak ended with exit status: 1.']
			}
		}
	}
];

describe('the clean-up words (SPEC-STORAGE S20, S24)', () => {
	it('sizes each item, or says the amount is unknown', () => {
		expect(sizeText({ kind: 'bytes', bytes: 2 * GB, files: 4210 })).toBe('2.0 GB in 4,210 files');
		expect(sizeText({ kind: 'bytes', bytes: 0, files: 0 })).toBe('Nothing to clean up');
		expect(sizeText({ kind: 'unknown' })).toBe('Frees an unknown amount, can take several minutes');
	});

	it('totals what is ticked and names it in the confirmation', () => {
		const ticked = new Set<CleanupItemId>(['old-var-tmp', 'unused-flatpaks']);
		expect(selectionText(SIZES, ticked)).toBe('2 items, 2.0 GB plus an unknown amount selected');
		expect(selectionText(SIZES, new Set())).toBe('Nothing selected');
		const words = confirmText(SIZES, ticked);
		expect(words).toContain('Old files in /var/tmp: 2.0 GB in 4,210 files.');
		expect(words).toContain('Unused Flatpak runtimes');
		expect(words).not.toContain('journal');
		expect(words).toContain('deleted for good');
	});

	it('says what each item did', () => {
		const [first, second] = DONE;
		if (first?.state.kind !== 'done' || second?.state.kind !== 'done') {
			throw new Error('fixture');
		}
		expect(resultText(first.state.result)).toBe('Freed 1.0 GB · 4,100 files removed · 110 skipped');
		expect(resultText(second.state.result)).toBe('Freed about 512 MB · 1 error');
	});

	it('writes both audit entries in plain words (S24)', () => {
		expect(activityLabel('storage-cleanup-started')).toBe('Started a disk clean-up');
		expect(activityLabel('storage-cleanup')).toBe('Cleaned up disk space');
		expect(cleanupStartDetail(['old-var-tmp', 'journal'])).toEqual({
			items: 'Old files in /var/tmp, System journal over 200 MB'
		});
		expect(cleanupAuditDetail(DONE, 'finished')).toEqual({
			items: 'Old files in /var/tmp, Unused Flatpak runtimes',
			freed: '1.5 GB',
			'files removed': '4,100',
			'files skipped': '110',
			errors: '1',
			result: 'Finished'
		});
		expect(cleanupAuditDetail([], 'interrupted')['result']).toBe('Stopped before the end');
	});
});
