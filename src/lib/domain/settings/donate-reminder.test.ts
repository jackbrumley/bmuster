import { describe, expect, it } from 'vitest';
import {
	DONATE_URL,
	donateReminder,
	nextDonateAnswer,
	type DonateAnswer,
	type DonateReminderInput
} from './donate-reminder.ts';

const DAY = 24 * 60 * 60 * 1000;
const SINCE = Date.parse('2026-10-01T00:00:00.000Z');

function input(overrides: Partial<DonateReminderInput>): DonateReminderInput {
	return {
		role: 'admin',
		inUseSince: { kind: 'at', ms: SINCE },
		machineCount: 1,
		answer: { kind: 'none' },
		now: SINCE + 20 * DAY,
		...overrides
	};
}

describe('donate reminder (SPEC-DONATE)', () => {
	it('D1: shows to an admin and never to a member', () => {
		expect(donateReminder(input({}))).toEqual({ kind: 'shown', wording: 'first' });
		expect(donateReminder(input({ role: 'member' }))).toEqual({ kind: 'hidden' });
		expect(donateReminder(input({ role: 'member', now: SINCE + 400 * DAY }))).toEqual({
			kind: 'hidden'
		});
	});

	it('D2: waits for 14 days in use and at least one machine', () => {
		expect(donateReminder(input({ now: SINCE + 14 * DAY - 1 }))).toEqual({ kind: 'hidden' });
		expect(donateReminder(input({ now: SINCE + 14 * DAY }))).toEqual({
			kind: 'shown',
			wording: 'first'
		});
		expect(donateReminder(input({ machineCount: 0 }))).toEqual({ kind: 'hidden' });
		expect(donateReminder(input({ inUseSince: { kind: 'not-set-up' } }))).toEqual({
			kind: 'hidden'
		});
	});

	it('D3: Not now hides it for 5 days, then adds the giving-back line', () => {
		const at = SINCE + 20 * DAY;
		const answer = nextDonateAnswer({ kind: 'none' }, 'not-now', at);
		expect(answer).toEqual({ kind: 'not-now', atMs: at, donatedBefore: false });
		expect(donateReminder(input({ answer, now: at + 5 * DAY - 1 }))).toEqual({ kind: 'hidden' });
		expect(donateReminder(input({ answer, now: at + 5 * DAY }))).toEqual({
			kind: 'shown',
			wording: 'again'
		});
	});

	it('D4: I have donated hides it for 90 days, then thanks them first', () => {
		const at = SINCE + 20 * DAY;
		const donated = nextDonateAnswer({ kind: 'none' }, 'donated', at);
		expect(donated).toEqual({ kind: 'donated', atMs: at });
		expect(donateReminder(input({ answer: donated, now: at + 90 * DAY - 1 }))).toEqual({
			kind: 'hidden'
		});
		expect(donateReminder(input({ answer: donated, now: at + 90 * DAY }))).toEqual({
			kind: 'shown',
			wording: 'thanks'
		});
	});

	it('D4: keeps thanking after a later Not now', () => {
		const donated: DonateAnswer = { kind: 'donated', atMs: SINCE };
		const later = SINCE + 100 * DAY;
		const notNow = nextDonateAnswer(donated, 'not-now', later);
		expect(notNow).toEqual({ kind: 'not-now', atMs: later, donatedBefore: true });
		const again = nextDonateAnswer(notNow, 'not-now', later + 6 * DAY);
		expect(again).toEqual({ kind: 'not-now', atMs: later + 6 * DAY, donatedBefore: true });
		expect(donateReminder(input({ answer: again, now: later + 20 * DAY }))).toEqual({
			kind: 'shown',
			wording: 'thanks'
		});
	});

	it('D8: links to the donate page on bmuster.com', () => {
		expect(DONATE_URL).toBe('https://bmuster.com/donate');
	});
});
