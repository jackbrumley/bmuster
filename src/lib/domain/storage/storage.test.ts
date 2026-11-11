import { describe, expect, it } from 'vitest';
import { scanLine, shareOf, splitFilePath, storageCrumbs, type DriveSummary } from './storage.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');

const drive: DriveSummary = {
	mount: '/',
	sizeBytes: 100,
	freeBytes: 10,
	lastScan: {
		kind: 'complete',
		startedAtMs: NOW - 4 * 3_600_000,
		finishedAtMs: NOW - 3 * 3_600_000,
		scannedBytes: 80,
		usedBytes: 90,
		files: 1,
		folders: 1,
		denied: 0
	},
	scanning: { kind: 'idle' }
};

describe('storage (SPEC-STORAGE S10)', () => {
	it('says how fresh the scan is, and how far a running one has got', () => {
		expect(scanLine(drive, NOW)).toBe('Scanned 3 h ago');
		const running = { kind: 'running' as const, startedAtMs: NOW, percent: 42 };
		expect(scanLine({ ...drive, scanning: running }, NOW)).toBe(
			'Scanned 3 h ago · scanning again, 42 %'
		);
		expect(scanLine({ ...drive, lastScan: { kind: 'none' }, scanning: running }, NOW)).toBe(
			'Scanning… 42 %'
		);
		expect(scanLine({ ...drive, lastScan: { kind: 'none' } }, NOW)).toBe('Not scanned yet');
	});

	it('builds breadcrumbs from the drive down, with each platform’s separator', () => {
		expect(storageCrumbs('/', '/var/log').map((crumb) => crumb.target)).toEqual([
			{ kind: 'roots' },
			{ kind: 'folder', path: '/' },
			{ kind: 'folder', path: '/var' },
			{ kind: 'folder', path: '/var/log' }
		]);
		expect(storageCrumbs('/home', '/home/kim').map((crumb) => crumb.label)).toEqual([
			'Drives',
			'/home',
			'kim'
		]);
		expect(storageCrumbs('C:\\', 'C:\\Users\\Kim').at(-1)).toEqual({
			label: 'Kim',
			target: { kind: 'folder', path: 'C:\\Users\\Kim' }
		});
	});

	it('splits a file path into its folder and name, keeping the root', () => {
		expect(splitFilePath('/var/log/syslog')).toEqual({ folder: '/var/log', name: 'syslog' });
		expect(splitFilePath('/big.iso')).toEqual({ folder: '/', name: 'big.iso' });
		expect(splitFilePath('C:\\pagefile.sys')).toEqual({ folder: 'C:\\', name: 'pagefile.sys' });
	});

	it('gives a share of the whole', () => {
		expect(shareOf(25, 100)).toBe(25);
		expect(shareOf(5, 0)).toBe(0);
	});
});
