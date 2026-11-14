import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SavedCommandView } from '#lib/domain/commands/saved-commands.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import {
	allSavedCommands,
	findSavedCommand,
	updateSavedCommand
} from '../services/commands/saved-commands.ts';
import { MIGRATIONS_FOLDER, type AppDatabase } from './connection.ts';
import * as schema from './schema.ts';

/** The migration that brings the unedited starters to their fail-loudly scripts (SC30). */
const MIGRATION = '0027_starter_scripts_fail_loudly';

const journalSchema = z.looseObject({ entries: z.array(z.looseObject({ tag: z.string() })) });

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

/** An in-memory database migrated up to, but not including, the migration. */
function databaseBefore(): AppDatabase {
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-starter-migration-'));
	folders.push(folder);
	cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
	const journalPath = join(folder, 'meta', '_journal.json');
	const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
	const cut = journal.entries.findIndex((entry) => entry.tag === MIGRATION);
	expect(cut).toBeGreaterThan(0);
	writeFileSync(
		journalPath,
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) })
	);
	const client = new Database(':memory:');
	client.pragma('foreign_keys = ON');
	const database = drizzle(client, { schema, casing: 'snake_case' });
	migrate(database, { migrationsFolder: folder });
	return database;
}

function named(database: AppDatabase, name: string): SavedCommandView {
	const command = allSavedCommands(database).find((entry) => entry.name === name);
	if (command === undefined) {
		throw new Error(`No saved command called ${name}`);
	}
	return command;
}

/** An admin's save through the repository, as the form does, one version on. */
function save(
	database: AppDatabase,
	command: SavedCommandView,
	userId: string,
	changes: Partial<Pick<SavedCommandView, 'enabled' | 'aiUnattended' | 'scripts'>>
): void {
	updateSavedCommand(database, {
		id: command.id,
		fields: {
			name: command.name,
			description: command.description,
			scripts: changes.scripts ?? command.scripts,
			machineGroupIds: command.machineGroupIds,
			parameters: command.parameters,
			effect: command.effect,
			enabled: changes.enabled ?? command.enabled,
			aiUnattended: changes.aiUnattended ?? command.aiUnattended,
			timeoutMs: command.timeoutMs
		},
		version: command.version + 1,
		userId,
		now: NOW
	});
}

describe('Starter scripts migration (SPEC-SAVED-COMMANDS SC30)', () => {
	it('SC30: updates the starters whose scripts are as seeded, and leaves an edited one alone', async () => {
		const database = databaseBefore();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		// Switched on, AI on: scripts untouched, so it still gets the fix.
		save(database, named(database, 'Uptime and last boot'), admin.id, {
			enabled: true,
			aiUnattended: true
		});
		// Its scripts rewritten by an admin: the migration must not touch it.
		const edited = [{ osFamily: 'linux', shell: 'sh', script: 'df -h /' }] as const;
		save(database, named(database, 'Disk space'), admin.id, { scripts: [...edited] });
		const diskBefore = database
			.select()
			.from(schema.savedCommands)
			.where(eq(schema.savedCommands.name, 'Disk space'))
			.get();

		migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });

		const fresh = allSavedCommands(testDatabase());
		const migrated = allSavedCommands(database);
		expect(migrated.map((command) => command.name)).toEqual(fresh.map((command) => command.name));
		for (const command of migrated) {
			const latest = fresh.find((entry) => entry.id === command.id);
			if (command.name === 'Disk space') {
				continue;
			}
			// The same scripts a new server gets, one version on, its switches as they were.
			expect(command.scripts, command.name).toEqual(latest?.scripts);
		}
		expect(named(database, 'Uptime and last boot')).toMatchObject({
			version: 3,
			enabled: true,
			aiUnattended: true
		});
		expect(named(database, 'Top processes')).toMatchObject({
			version: 2,
			enabled: false,
			aiUnattended: false
		});
		expect(
			database
				.select()
				.from(schema.savedCommands)
				.where(eq(schema.savedCommands.name, 'Disk space'))
				.get()
		).toEqual(diskBefore);
		expect(findSavedCommand(database, named(database, 'Disk space').id)?.scripts).toEqual(edited);
	});

	it('SC30: a new server’s starters have the fixed scripts at version 2, off', () => {
		for (const command of allSavedCommands(testDatabase())) {
			expect(command, command.name).toMatchObject({
				version: 2,
				enabled: false,
				aiUnattended: false
			});
			expect(
				command.scripts.find((script) => script.osFamily === 'windows')?.script,
				command.name
			).toMatch(/^\$ErrorActionPreference = 'Stop'\n/);
		}
	});
});
