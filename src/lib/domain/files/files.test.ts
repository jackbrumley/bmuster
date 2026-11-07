import { describe, expect, it } from 'vitest';
import {
	arrangeEntries,
	baseName,
	breadcrumbs,
	joinPath,
	parentPath,
	type FileEntry
} from './files.ts';

function entry(name: string, kind: FileEntry['kind'], size: number, modifiedMs: number): FileEntry {
	return { name, kind, size, modifiedMs, hidden: name.startsWith('.'), linkTarget: null };
}

describe('paths in the Files tab (SPEC-FILES F9)', () => {
	it('joins, climbs and names paths on each platform', () => {
		expect(joinPath('unix', '/', 'home')).toBe('/home');
		expect(joinPath('unix', '/home/kim/', 'a.txt')).toBe('/home/kim/a.txt');
		expect(joinPath('windows', 'C:\\', 'Users')).toBe('C:\\Users');
		expect(joinPath('windows', 'c:\\Users\\Public', 'x.msi')).toBe('C:\\Users\\Public\\x.msi');
		expect(parentPath('unix', '/home/kim')).toBe('/home');
		expect(parentPath('unix', '/home')).toBe('/');
		expect(parentPath('unix', '/')).toBeUndefined();
		expect(parentPath('windows', 'C:\\Users')).toBe('C:\\');
		expect(parentPath('windows', 'D:\\')).toBeUndefined();
		expect(baseName('windows', 'C:\\Logs\\setup.log')).toBe('setup.log');
		expect(baseName('unix', '/srv/data.bin')).toBe('data.bin');
	});

	it('breaks a path into crumbs, with This PC first on Windows', () => {
		expect(breadcrumbs('windows', 'C:\\Users\\Public')).toEqual([
			{ label: 'This PC', target: { kind: 'roots' } },
			{ label: 'C:', target: { kind: 'folder', path: 'C:\\' } },
			{ label: 'Users', target: { kind: 'folder', path: 'C:\\Users' } },
			{ label: 'Public', target: { kind: 'folder', path: 'C:\\Users\\Public' } }
		]);
		expect(breadcrumbs('unix', '/home/kim')).toEqual([
			{ label: '/', target: { kind: 'folder', path: '/' } },
			{ label: 'home', target: { kind: 'folder', path: '/home' } },
			{ label: 'kim', target: { kind: 'folder', path: '/home/kim' } }
		]);
	});

	it('sorts folders first, then by name, date or size, hiding hidden entries unless asked', () => {
		const entries = [
			entry('b.txt', 'file', 10, 3),
			entry('A folder', 'folder', 0, 1),
			entry('file10', 'file', 300, 1),
			entry('file9', 'file', 5, 2),
			entry('.secret', 'file', 1, 9)
		];
		const names = (sort: 'name' | 'date' | 'size', hidden: boolean) =>
			arrangeEntries(entries, sort, hidden).map((item) => item.name);
		expect(names('name', false)).toEqual(['A folder', 'b.txt', 'file9', 'file10']);
		expect(names('date', false)).toEqual(['A folder', 'b.txt', 'file9', 'file10']);
		expect(names('size', false)).toEqual(['A folder', 'file10', 'b.txt', 'file9']);
		expect(names('name', true)).toEqual(['A folder', '.secret', 'b.txt', 'file9', 'file10']);
	});
});
