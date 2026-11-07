import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.ts';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** The database or an open transaction: what repositories take, so callers can group writes. */
export type Queryable = AppDatabase | Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** Where the generated migrations live, relative to the working directory. */
const MIGRATIONS_FOLDER = 'src/lib/server/database/migrations';

/**
 * Opens (or creates) the SQLite file and applies every committed migration.
 * `:memory:` gives tests a fresh database.
 */
export function openDatabase(path: string): AppDatabase {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}
	const client = new Database(path);
	// Write-ahead logging lets the console read while agents write check-ins.
	client.pragma('journal_mode = WAL');
	client.pragma('foreign_keys = ON');
	client.pragma('busy_timeout = 5000');
	const database = drizzle(client, { schema, casing: 'snake_case' });
	migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
	return database;
}
