import { env } from '../env.ts';
import { openDatabase } from './connection.ts';

/** The server's database, opened and migrated when this module first loads. */
export const database = openDatabase(env.databasePath);
