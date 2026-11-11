import { describe, expect, it } from 'vitest';
import {
	lowDiskAlerts,
	lowDiskDrives,
	lowDiskText,
	scanLine,
	shareOf,
	splitFilePath,
	storageCrumbs,
	type DriveSummary
} from './storage.ts';

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

describe('nearly full drives (SPEC-STORAGE S21)', () => {
	const space = (mount: string, usedPercent: number) => ({
		mount,
		sizeBytes: 1000,
		freeBytes: 1000 - usedPercent * 10
	});

	it('are the drives at 90 % used or more, fullest first', () => {
		const low = lowDiskDrives([space('/', 89.9), space('/home', 94.5), space('/srv', 90)]);
		expect(low).toEqual([
			{ mount: '/home', percent: 94, freeBytes: 55 },
			{ mount: '/srv', percent: 90, freeBytes: 100 }
		]);
		expect(lowDiskText(low)).toBe('/home 94 %, /srv 90 %');
		expect(lowDiskDrives([{ mount: '/', sizeBytes: 0, freeBytes: 0 }])).toEqual([]);
	});
});

describe('Disk nearly full alerts (SPEC-STORAGE S23)', () => {
	const space = (usedPercent: number) => [
		{ mount: 'C:\\', sizeBytes: 1000, freeBytes: 1000 - usedPercent * 10 }
	];

	it('raise once on reaching 90 %, and again only after dropping below 85 %', () => {
		let alerted: string[] = [];
		const step = (usedPercent: number): number => {
			const next = lowDiskAlerts(space(usedPercent), alerted);
			alerted = next.alerted;
			return next.raise.length;
		};
		expect(step(80)).toBe(0);
		expect(step(91)).toBe(1);
		expect(step(95)).toBe(0);
		expect(step(87)).toBe(0);
		expect(step(92)).toBe(0);
		expect(step(84)).toBe(0);
		expect(alerted).toEqual([]);
		expect(step(90)).toBe(1);
	});

	it('forgets a drive that is gone', () => {
		expect(lowDiskAlerts([], ['D:\\']).alerted).toEqual([]);
	});
});
