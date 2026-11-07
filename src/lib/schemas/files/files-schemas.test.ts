import { describe, expect, it } from 'vitest';
import { newNameProblem } from '#lib/domain/files/files.ts';
import {
	deleteRequestSchema,
	filePathSchema,
	fileNameSchema,
	uploadChunkQuerySchema,
	uploadEndRequestSchema
} from './files.ts';

describe('names and paths the console sends (SPEC-FILES F4)', () => {
	it('allows one-part names only', () => {
		for (const good of ['report.pdf', '.bashrc', 'My Files', 'a:b']) {
			expect(fileNameSchema.safeParse(good).success, good).toBe(true);
		}
		for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256)]) {
			expect(fileNameSchema.safeParse(bad).success, bad).toBe(false);
		}
		expect(filePathSchema.safeParse('/srv\0x').success).toBe(false);
	});

	it('says why a new name will not do, with the Windows rules on Windows', () => {
		expect(newNameProblem('unix', 'Reports')).toBeUndefined();
		expect(newNameProblem('unix', 'CON')).toBeUndefined();
		expect(newNameProblem('unix', '')).toBe('Type a name.');
		expect(newNameProblem('unix', '..')).toBe('That is not a name.');
		expect(newNameProblem('unix', 'a/b')).toBe('A name cannot contain / or \\.');
		expect(newNameProblem('unix', 'a\\b')).toBe('A name cannot contain / or \\.');
		expect(newNameProblem('unix', 'file.txt:stream')).toBe('A name cannot contain a colon.');
		expect(newNameProblem('unix', 'line\nbreak')).toBe('A name cannot contain control characters.');
		expect(newNameProblem('windows', 'CON')).toBe('CON is a reserved name on Windows.');
		expect(newNameProblem('windows', 'nul.txt')).toBe('nul.txt is a reserved name on Windows.');
		expect(newNameProblem('windows', 'COM1')).toBe('COM1 is a reserved name on Windows.');
		expect(newNameProblem('windows', 'CONSOLE.txt')).toBeUndefined();
		expect(newNameProblem('windows', 'a?b')).toBe(
			'On Windows a name cannot contain < > " | ? or *.'
		);
		expect(newNameProblem('windows', 'name.')).toBe(
			'On Windows a name cannot end with a dot or a space.'
		);
	});

	it('checks upload and delete requests', () => {
		expect(
			uploadChunkQuerySchema.safeParse({ dir: '/srv', name: 'a.bin', offset: '8388608' })
		).toMatchObject({ success: true, data: { offset: 8388608 } });
		expect(
			uploadChunkQuerySchema.safeParse({ dir: '/srv', name: 'a.bin', offset: '-1' }).success
		).toBe(false);
		expect(
			uploadEndRequestSchema.safeParse({ dir: '/srv', name: 'a', size: 1, sha256: 'ABC' }).success
		).toBe(false);
		expect(
			deleteRequestSchema.safeParse({ dir: '/srv', names: [], recursive: false }).success
		).toBe(false);
		expect(
			deleteRequestSchema.safeParse({ dir: '/srv', names: ['../etc'], recursive: true }).success
		).toBe(false);
	});
});
