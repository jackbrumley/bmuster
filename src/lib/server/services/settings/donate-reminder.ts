import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	nextDonateAnswer,
	type DonateAnswer,
	type DonateChoice
} from '#lib/domain/settings/donate-reminder.ts';
import { settings } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * The donation reminder's last answer (SPEC-DONATE D6), one row in the
 * settings table for the whole server. It is not one of the Settings page's
 * editable settings: only an admin's answer changes it, and each is audited.
 */
const KEY = 'donate.reminder';

const answerSchema: z.ZodType<DonateAnswer> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('not-now'), atMs: z.int(), donatedBefore: z.boolean() }),
	z.object({ kind: z.literal('donated'), atMs: z.int() })
]);

const ANSWER_LABEL: Record<DonateAnswer['kind'], string> = {
	none: 'not answered',
	'not-now': 'not now',
	donated: 'donated'
};

export function readDonateAnswer(database: Queryable): DonateAnswer {
	const row = database.select().from(settings).where(eq(settings.key, KEY)).get();
	return row === undefined ? { kind: 'none' } : answerSchema.parse(JSON.parse(row.value));
}

/** Keeps an admin's answer and audits who gave it (D3, D4, D5). */
export function answerDonateReminder(
	database: AppDatabase,
	actorUserId: string,
	choice: DonateChoice,
	now: number
): void {
	database.transaction((transaction) => {
		const before = readDonateAnswer(transaction);
		const after = nextDonateAnswer(before, choice, now);
		const value = JSON.stringify(after);
		transaction
			.insert(settings)
			.values({ key: KEY, value, updatedAt: new Date(now), updatedBy: actorUserId })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedAt: new Date(now), updatedBy: actorUserId }
			})
			.run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'setting-changed',
				target: 'Donation reminder',
				machineId: null,
				detail: { from: ANSWER_LABEL[before.kind], to: ANSWER_LABEL[after.kind] }
			},
			now
		);
	});
}
