import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { env } from '../env.ts';
import * as schema from './schema.ts';

const client = new Database(env.databasePath);
// Write-ahead logging lets the console read while agents write check-ins.
client.pragma('journal_mode = WAL');
client.pragma('foreign_keys = ON');
client.pragma('busy_timeout = 5000');

export const database = drizzle(client, { schema });
