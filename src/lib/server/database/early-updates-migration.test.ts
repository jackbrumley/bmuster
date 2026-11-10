import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { done } from '#tests/helpers/access.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { createGroup, listMachineGroups, setGroupMembers } from '../services/access/groups.ts';
import { createRule } from '../services/access/rules.ts';
import { MIGRATIONS_FOLDER, type AppDatabase } from './connection.ts';
import * as schema from './schema.ts';

/** The migration that makes Early updates a built-in machine group (SPEC-ACCESS A11). */
const EARLY_UPDATES_MIGRATION = '0010_early_updates_group';
/** The migration that makes Test a built-in machine group (SPEC-TEST-CHANNEL T3). */
const TEST_GROUP_MIGRATION = '0016_test_group';

const journalSchema = z.looseObject({ entries: z.array(z.looseObject({ tag: z.string() })) });

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

/** A copy of the migrations folder whose journal stops before `migration`. */
function migrationsBefore(migration: string): string {
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-early-migration-'));
	folders.push(folder);
	cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
	const journalPath = join(folder, 'meta', '_journal.json');
	const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
	const cut = journal.entries.findIndex((entry) => entry.tag === migration);
	expect(cut).toBeGreaterThan(0);
	writeFileSync(
		journalPath,
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) })
	);
	return folder;
}

/** An in-memory database migrated up to, but not including, `migration`. */
function databaseBefore(migration: string): AppDatabase {
	const client = new Database(':memory:');
	client.pragma('foreign_keys = ON');
	const database = drizzle(client, { schema, casing: 'snake_case' });
	migrate(database, { migrationsFolder: migrationsBefore(migration) });
	return database;
}

function databaseBeforeEarlyUpdates(): AppDatabase {
	return databaseBefore(EARLY_UPDATES_MIGRATION);
}

/**
 * A machine row with only the columns the schema had before the migration:
 * enrolment code writes today's columns, which an older database lacks.
 */
function insertMachineBeforeEarlyUpdates(database: AppDatabase): string {
	const id = crypto.randomUUID();
	database.$client
		.prepare(
			`INSERT INTO machines (id, name, hostname, os_family, target, agent_version, public_key,
				last_request_ms, check_in_seconds, enrolled_at, last_seen_at)
			VALUES (?, 'Test machine', 'test-host', 'linux', 'x86_64-unknown-linux-gnu', '0.1.0', 'key',
				0, 300, ?, ?)`
		)
		.run(id, NOW, NOW);
	return id;
}

function migrateToLatest(database: AppDatabase): void {
	migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
}

describe('Early updates migration (SPEC-ACCESS A11, SPEC-AGENT-UPDATES U8)', () => {
	it('A11: makes a new built-in Early updates group when there is none', () => {
		const database = databaseBeforeEarlyUpdates();
		expect(listMachineGroups(database).map((group) => group.name)).toEqual(['All machines']);
		migrateToLatest(database);
		expect(listMachineGroups(database)[1]).toEqual({
			id: '00000000-0000-4000-8000-0000000ea51e',
			name: 'Early updates',
			description:
				'New agent versions reach these machines first. Put one or two test machines here.',
			builtIn: 'early',
			membership: { kind: 'chosen', machineIds: [] }
		});
	});

	it('A11: turns an existing group of that name (any case) into the built-in one, keeping its machines and rules', async () => {
		const database = databaseBeforeEarlyUpdates();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const first = insertMachineBeforeEarlyUpdates(database);
		const second = insertMachineBeforeEarlyUpdates(database);
		const early = done(
			createGroup(
				database,
				'machine',
				admin.id,
				{ name: 'early Updates', description: 'Test PCs' },
				NOW
			)
		);
		done(setGroupMembers(database, 'machine', admin.id, early, [first, second], NOW));
		const testers = done(
			createGroup(database, 'user', admin.id, { name: 'Testers', description: '' }, NOW)
		);
		done(
			createRule(
				database,
				admin.id,
				{ userGroupId: testers, machineGroupId: early, permissions: ['view'], consent: 'ask' },
				NOW
			)
		);
		done(createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW));

		migrateToLatest(database);

		const groups = listMachineGroups(database);
		expect(groups.map((group) => group.name)).toEqual([
			'All machines',
			'early Updates',
			'Test',
			'Office'
		]);
		expect(groups.filter((group) => group.builtIn === 'early')).toHaveLength(1);
		const migrated = groups[1];
		expect(migrated).toMatchObject({ id: early, description: 'Test PCs', builtIn: 'early' });
		const members = migrated?.membership.kind === 'chosen' ? migrated.membership.machineIds : [];
		expect(members.toSorted()).toEqual([first, second].toSorted());
		expect(
			database
				.select()
				.from(schema.accessRules)
				.all()
				.map((rule) => rule.machineGroupId)
		).toEqual([early]);
	});
});

describe('Test group migration (SPEC-TEST-CHANNEL T3)', () => {
	it('T3: makes a new built-in Test group after Early updates when there is none', () => {
		const database = databaseBefore(TEST_GROUP_MIGRATION);
		expect(listMachineGroups(database).map((group) => group.name)).toEqual([
			'All machines',
			'Early updates'
		]);
		migrateToLatest(database);
		expect(listMachineGroups(database)[2]).toEqual({
			id: '00000000-0000-4000-8000-000000007e57',
			name: 'Test',
			description:
				'Test builds reach these machines before a full release. Put the machines a fix is aimed at here.',
			builtIn: 'test',
			membership: { kind: 'chosen', machineIds: [] }
		});
	});

	it('T3: turns an existing group called test (any case) into the built-in one, keeping its machines', async () => {
		const database = databaseBefore(TEST_GROUP_MIGRATION);
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const laptop = insertMachineBeforeEarlyUpdates(database);
		const testers = done(
			createGroup(database, 'machine', admin.id, { name: 'TEST', description: 'Laptops' }, NOW)
		);
		done(setGroupMembers(database, 'machine', admin.id, testers, [laptop], NOW));
		migrateToLatest(database);
		const groups = listMachineGroups(database);
		expect(groups.filter((group) => group.builtIn === 'test')).toEqual([
			{
				id: testers,
				name: 'TEST',
				description: 'Laptops',
				builtIn: 'test',
				membership: { kind: 'chosen', machineIds: [laptop] }
			}
		]);
	});
});
