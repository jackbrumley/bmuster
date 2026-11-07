import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppDatabase } from './connection.ts';

/**
 * Whether the database is ready to serve (SPEC-SERVER-INSTALL I14, GET
 * /readyz): it answers a query and every committed migration has been
 * applied. Container platforms and the installers wait on this; the reason
 * goes to the log, never to the anonymous caller.
 */
export type Readiness = { kind: 'ready' } | { kind: 'not-ready'; reason: string };

const Journal = z.object({ entries: z.array(z.object({ tag: z.string() })) });
const AppliedCount = z.object({ applied: z.number() });

export function databaseReadiness(database: AppDatabase, migrationsFolder: string): Readiness {
	try {
		const committed = Journal.parse(
			JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'))
		).entries.length;
		const { applied } = AppliedCount.parse(
			database.get(sql`select count(*) as applied from __drizzle_migrations`)
		);
		if (applied < committed) {
			return {
				kind: 'not-ready',
				reason: `${String(applied)} of ${String(committed)} migrations applied`
			};
		}
		return { kind: 'ready' };
	} catch (error) {
		return {
			kind: 'not-ready',
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
