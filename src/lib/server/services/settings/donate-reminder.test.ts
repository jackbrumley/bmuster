import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { donateReminder } from '#lib/domain/settings/donate-reminder.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { settings } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { answerDonateReminder, readDonateAnswer } from './donate-reminder.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-14T00:00:00.000Z');

function shownAt(database: ReturnType<typeof testDatabase>, now: number) {
	return donateReminder({
		role: 'admin',
		inUseSince: { kind: 'at', ms: NOW - 30 * DAY },
		machineCount: 1,
		answer: readDonateAnswer(database),
		now
	});
}

describe('donate reminder setting (SPEC-DONATE)', () => {
	it('D6: starts unanswered, with no row in the settings table', () => {
		const database = testDatabase();
		expect(readDonateAnswer(database)).toEqual({ kind: 'none' });
	});

	it('D3: Not now is stored for the whole server and hides it for 5 days', () => {
		const database = testDatabase();
		answerDonateReminder(database, 'admin-1', 'not-now', NOW);
		expect(readDonateAnswer(database)).toEqual({
			kind: 'not-now',
			atMs: NOW,
			donatedBefore: false
		});
		expect(shownAt(database, NOW + 4 * DAY)).toEqual({ kind: 'hidden' });
		expect(shownAt(database, NOW + 5 * DAY)).toEqual({ kind: 'shown', wording: 'again' });
	});

	it('D4: I have donated hides it for 90 days, then thanks, even after a later Not now', () => {
		const database = testDatabase();
		answerDonateReminder(database, 'admin-1', 'donated', NOW);
		expect(shownAt(database, NOW + 89 * DAY)).toEqual({ kind: 'hidden' });
		expect(shownAt(database, NOW + 90 * DAY)).toEqual({ kind: 'shown', wording: 'thanks' });
		answerDonateReminder(database, 'admin-1', 'not-now', NOW + 90 * DAY);
		expect(shownAt(database, NOW + 96 * DAY)).toEqual({ kind: 'shown', wording: 'thanks' });
	});

	it('D5: records who answered and when in the audit log', () => {
		const database = testDatabase();
		answerDonateReminder(database, 'admin-1', 'donated', NOW);
		const [entry] = listAudit(database, 10);
		expect(entry).toMatchObject({
			actorUserId: 'admin-1',
			kind: 'setting-changed',
			target: 'Donation reminder',
			detail: { from: 'not answered', to: 'donated' }
		});
		expect(entry?.at.getTime()).toBe(NOW);
	});

	it('D6: a stored value of the wrong shape fails loudly', () => {
		const database = testDatabase();
		database
			.insert(settings)
			.values({
				key: 'donate.reminder',
				value: JSON.stringify({ kind: 'never' }),
				updatedAt: new Date(NOW),
				updatedBy: 'system'
			})
			.run();
		expect(() => readDonateAnswer(database)).toThrow();
		database.delete(settings).where(eq(settings.key, 'donate.reminder')).run();
		expect(readDonateAnswer(database)).toEqual({ kind: 'none' });
	});
});
