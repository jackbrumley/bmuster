import type { ConsoleRole } from '../users/user.ts';

/**
 * The donation reminder (SPEC-DONATE): a slim line at the bottom of the
 * Machines page, for admins only. These rules decide whether it shows and
 * with which wording; the server keeps the last answer as a setting.
 */

/** The donate page on the project website. Only the admin's own click opens it. */
export const DONATE_URL = 'https://bmuster.com/donate';

const DAY_MS = 24 * 60 * 60 * 1000;

/** D2: how long the server is in use before the first reminder. */
const START_AFTER_MS = 14 * DAY_MS;
/** D3: how long "Not now" hides it. */
const NOT_NOW_MS = 5 * DAY_MS;
/** D4: how long "I've donated, thank you" hides it. */
const DONATED_MS = 90 * DAY_MS;

export const DONATE_CHOICES = ['not-now', 'donated'] as const;

/** What an admin pressed. */
export type DonateChoice = (typeof DONATE_CHOICES)[number];

/**
 * The last answer, kept for the whole server. `donatedBefore` remembers a
 * donation through a later "Not now", so the reminder keeps thanking them.
 */
export type DonateAnswer =
	| { kind: 'none' }
	| { kind: 'not-now'; atMs: number; donatedBefore: boolean }
	| { kind: 'donated'; atMs: number };

/** When the server came into use: its first account's creation, if one exists. */
export type InUseSince = { kind: 'not-set-up' } | { kind: 'at'; ms: number };

export type DonateReminderInput = {
	role: ConsoleRole;
	inUseSince: InUseSince;
	machineCount: number;
	answer: DonateAnswer;
	now: number;
};

/** first: never answered · again: after a "Not now" · thanks: they said they donated. */
export type DonateWording = 'first' | 'again' | 'thanks';

export type DonateReminder = { kind: 'hidden' } | { kind: 'shown'; wording: DonateWording };

const HIDDEN: DonateReminder = { kind: 'hidden' };

export function donateReminder(input: DonateReminderInput): DonateReminder {
	if (input.role !== 'admin' || input.machineCount === 0 || input.inUseSince.kind !== 'at') {
		return HIDDEN;
	}
	if (input.now - input.inUseSince.ms < START_AFTER_MS) {
		return HIDDEN;
	}
	const { answer, now } = input;
	switch (answer.kind) {
		case 'none':
			return { kind: 'shown', wording: 'first' };
		case 'not-now':
			return now - answer.atMs < NOT_NOW_MS
				? HIDDEN
				: { kind: 'shown', wording: answer.donatedBefore ? 'thanks' : 'again' };
		case 'donated':
			return now - answer.atMs < DONATED_MS ? HIDDEN : { kind: 'shown', wording: 'thanks' };
	}
}

/** The answer to keep after `choice`, remembering any earlier donation. */
export function nextDonateAnswer(
	previous: DonateAnswer,
	choice: DonateChoice,
	now: number
): DonateAnswer {
	switch (choice) {
		case 'donated':
			return { kind: 'donated', atMs: now };
		case 'not-now':
			return {
				kind: 'not-now',
				atMs: now,
				donatedBefore:
					previous.kind === 'donated' || (previous.kind === 'not-now' && previous.donatedBefore)
			};
	}
}
