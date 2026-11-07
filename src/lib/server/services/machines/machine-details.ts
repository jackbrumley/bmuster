import { eq } from 'drizzle-orm';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

export type DetailsChange =
	{ kind: 'saved'; name: string; description: string } | { kind: 'no-machine' };

/**
 * Renames a machine and sets its description (SPEC-MACHINE-DETAILS D1, D2).
 * Input is already checked by the request schema. Each real change is
 * audited (D5) in the same transaction; saving the same values writes nothing.
 */
export function updateMachineDetails(
	database: AppDatabase,
	id: string,
	details: { name: string; description: string },
	changedBy: string,
	now: number
): DetailsChange {
	return database.transaction((tx) => {
		const row = tx
			.select({
				name: machines.name,
				description: machines.description,
				removedAt: machines.removedAt
			})
			.from(machines)
			.where(eq(machines.id, id))
			.get();
		if (row?.removedAt !== null) {
			return { kind: 'no-machine' };
		}
		tx.update(machines)
			.set({ name: details.name, description: details.description })
			.where(eq(machines.id, id))
			.run();
		const actor = { kind: 'user', userId: changedBy } as const;
		if (row.name !== details.name) {
			recordAudit(
				tx,
				{ actor, kind: 'machine-renamed', target: details.name, detail: { from: row.name } },
				now
			);
		}
		if (row.description !== details.description) {
			recordAudit(
				tx,
				{
					actor,
					kind: 'machine-description-changed',
					target: details.name,
					detail: { description: details.description === '' ? '(none)' : details.description }
				},
				now
			);
		}
		return { kind: 'saved', name: details.name, description: details.description };
	});
}
