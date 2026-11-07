import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	delayUntilNext,
	pruneSnapshots,
	snapshotFolderFor,
	snapshotName,
	writeSnapshot
} from './snapshots.ts';

const folders: string[] = [];

function scratchFolder(): string {
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-snapshots-'));
	folders.push(folder);
	return folder;
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

describe('database snapshots (SPEC-HOSTING H3)', () => {
	it('H3: are named by local date in backups/ beside the database', () => {
		expect(snapshotName(new Date(2026, 0, 5, 3, 0))).toBe('bmuster-2026-01-05.db');
		expect(snapshotFolderFor('/data/bmuster.db')).toBe('/data/backups');
	});

	it('H3: rotation keeps the newest and leaves other files alone', () => {
		const folder = scratchFolder();
		const names = [
			'bmuster-2026-10-30.db',
			'bmuster-2026-11-01.db',
			'bmuster-2026-10-31.db',
			'bmuster-2026-11-02.db',
			'notes.txt',
			'.bmuster-2026-11-03.db.partial'
		];
		for (const name of names) {
			writeFileSync(join(folder, name), '');
		}
		expect(pruneSnapshots(folder, 2)).toEqual(['bmuster-2026-10-30.db', 'bmuster-2026-10-31.db']);
		expect(readdirSync(folder).sort()).toEqual([
			'.bmuster-2026-11-03.db.partial',
			'bmuster-2026-11-01.db',
			'bmuster-2026-11-02.db',
			'notes.txt'
		]);
		expect(pruneSnapshots(folder, 14)).toEqual([]);
	});

	it('H3: writes a whole, readable copy under its final name only, then prunes', async () => {
		const folder = scratchFolder();
		const live = new Database(join(folder, 'bmuster.db'));
		live.pragma('journal_mode = WAL');
		live.exec("create table things (name text); insert into things values ('kept')");
		const backups = join(folder, 'backups');
		for (const old of ['bmuster-2026-11-01.db', 'bmuster-2026-11-02.db']) {
			await writeSnapshot(live, backups, 14, new Date(`${old.slice(8, 18)}T03:00:00`));
		}

		const result = await writeSnapshot(live, backups, 2, new Date('2026-11-07T03:00:00'));
		expect(result.path).toBe(join(backups, 'bmuster-2026-11-07.db'));
		expect(result.pruned).toEqual(['bmuster-2026-11-01.db']);
		expect(readdirSync(backups).sort()).toEqual(['bmuster-2026-11-02.db', 'bmuster-2026-11-07.db']);

		const copy = new Database(result.path, { readonly: true });
		expect(copy.prepare('select name from things').all()).toEqual([{ name: 'kept' }]);
		expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
		copy.close();
		live.close();
	});

	it('H3: a second snapshot on the same day replaces the first', async () => {
		const folder = scratchFolder();
		const live = new Database(join(folder, 'bmuster.db'));
		live.exec('create table things (name text)');
		const backups = join(folder, 'backups');
		await writeSnapshot(live, backups, 14, new Date('2026-11-07T03:00:00'));
		live.exec("insert into things values ('later')");
		await writeSnapshot(live, backups, 14, new Date('2026-11-07T15:00:00'));
		expect(readdirSync(backups)).toEqual(['bmuster-2026-11-07.db']);
		const copy = new Database(join(backups, 'bmuster-2026-11-07.db'), { readonly: true });
		expect(copy.prepare('select count(*) as n from things').get()).toEqual({ n: 1 });
		copy.close();
		live.close();
	});

	it('H3: the next run is later today, or tomorrow once the time has passed', () => {
		const morning = new Date(2026, 10, 7, 1, 30);
		expect(delayUntilNext(morning, 3, 0)).toBe(90 * 60_000);
		const afternoon = new Date(2026, 10, 7, 15, 0);
		expect(delayUntilNext(afternoon, 3, 0)).toBe(12 * 60 * 60_000);
		const exactly = new Date(2026, 10, 7, 3, 0);
		expect(delayUntilNext(exactly, 3, 0)).toBe(24 * 60 * 60_000);
	});
});
