import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { MIGRATIONS_FOLDER } from './connection.ts';
import { databaseReadiness } from './readiness.ts';

const folders: string[] = [];

/** A migrations folder whose journal lists `count` migrations. */
function journalWith(count: number): string {
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-readiness-'));
	folders.push(folder);
	mkdirSync(join(folder, 'meta'));
	const entries = Array.from({ length: count }, (_, idx) => ({ idx, tag: `000${String(idx)}_x` }));
	writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }));
	return folder;
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

describe('database readiness (SPEC-SERVER-INSTALL I14)', () => {
	it('is ready once every committed migration is applied', () => {
		expect(databaseReadiness(testDatabase(), MIGRATIONS_FOLDER)).toEqual({ kind: 'ready' });
	});

	it('is not ready while a committed migration is missing', () => {
		const readiness = databaseReadiness(testDatabase(), journalWith(999));
		if (readiness.kind !== 'not-ready') throw new Error('expected not ready');
		expect(readiness.reason).toMatch(/^\d+ of 999 migrations applied$/);
	});

	it('is not ready when the migrations cannot be read', () => {
		expect(databaseReadiness(testDatabase(), join(tmpdir(), 'no-such-bmuster-folder')).kind).toBe(
			'not-ready'
		);
	});
});
