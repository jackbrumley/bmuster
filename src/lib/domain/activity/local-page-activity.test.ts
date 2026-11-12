import { describe, expect, it } from 'vitest';
import type { ActivityEntry, AuditKind } from './activity.ts';
import { activitySentence, whoseCode } from './local-page-activity.ts';

const SENT = '2026-11-07T10:05:00.000Z';
const JACK = "Jack Brumley's code";

function entry(kind: AuditKind, detail: Record<string, string>): ActivityEntry {
	return {
		id: 'e1',
		kind,
		atIso: '2026-11-07T10:00:00.000Z',
		actor: { kind: 'system' },
		target: 'mint',
		detail: Object.entries({ ...detail, sentIso: SENT }).map(([label, value]) => ({
			label,
			value
		}))
	};
}

function text(kind: AuditKind, detail: Record<string, string>): string {
	const sentence = activitySentence(entry(kind, detail));
	if (sentence.kind !== 'local') throw new Error(`${kind} is not a local page entry`);
	return sentence.text;
}

describe('Activity wording for the local page (SPEC-AGENT-LOCAL 7, E3)', () => {
	it('names whose code', () => {
		expect(whoseCode({ kind: 'people', names: ['Jack Brumley'] })).toBe(JACK);
		expect(whoseCode({ kind: 'people', names: ['Ann', 'Ben'] })).toBe(
			"Ann and Ben's codes (they matched at once)"
		);
		expect(whoseCode({ kind: 'machine' })).toBe('the shared machine code');
	});

	it('words each event', () => {
		const whose = { whose: JACK };
		expect(text('local-signed-in', whose)).toBe(
			"Jack Brumley's code signed in to the local page on mint"
		);
		expect(text('local-signed-in', { whose: 'the shared machine code' })).toBe(
			'The shared machine code signed in to the local page on mint'
		);
		expect(text('local-restarted', whose)).toBe(
			"Restarted the agent from the local page on mint (signed in with Jack Brumley's code)"
		);
		expect(text('local-signed-out', whose)).toBe(
			"Signed out of the local page on mint (signed in with Jack Brumley's code)"
		);
		expect(text('local-session-expired', whose)).toContain('A local page session on mint ended');
		expect(text('local-connection-tested', { ...whose, passed: 'yes' })).toContain(': passed');
		expect(text('local-move-started', { ...whose, server: 'https://b.example' })).toBe(
			"Started moving mint to https://b.example from the local page (signed in with Jack Brumley's code)"
		);
		expect(text('local-move-finished', { ...whose, server: 'https://b.example' })).toContain(
			'Moved mint to https://b.example'
		);
		expect(text('local-move-failed', { ...whose, reason: 'refused' })).toContain('failed: refused');
		expect(text('local-leaving', { ...whose, reason: 'uninstalled' })).toContain(
			'because it is being uninstalled'
		);
		expect(text('local-uninstalled', whose)).toContain('Uninstalled the agent on mint');
	});

	it('shows wrong codes, lockouts, failures and lost events as warnings', () => {
		const warning = (kind: AuditKind, detail: Record<string, string>) => {
			const sentence = activitySentence(entry(kind, detail));
			return sentence.kind === 'local' && sentence.warning;
		};
		expect(warning('local-wrong-code', {})).toBe(true);
		expect(warning('local-locked-out', {})).toBe(true);
		expect(warning('local-events-dropped', { count: '3' })).toBe(true);
		expect(warning('local-connection-tested', { whose: JACK, passed: 'no' })).toBe(true);
		expect(warning('local-signed-in', { whose: JACK })).toBe(false);
		expect(activitySentence(entry('local-signed-in', { whose: JACK }))).toMatchObject({
			sentIso: SENT
		});
	});

	it('words a machine going offline and coming back by its name (SPEC-PRESENCE P6)', () => {
		expect(activitySentence(entry('machine-offline', {}))).toEqual({
			kind: 'machine',
			text: 'mint went offline',
			warning: true
		});
		expect(activitySentence(entry('machine-online', {}))).toEqual({
			kind: 'machine',
			text: 'mint came back online',
			warning: false
		});
	});

	it('words BMuster removed at the machine by a local administrator (SPEC-LOCAL-PAGE-TRANSPARENCY T7)', () => {
		expect(activitySentence(entry('machine-removed-at-machine', {}))).toEqual({
			kind: 'machine',
			text: 'BMuster was removed from mint at the machine by a local administrator',
			warning: true
		});
	});

	it('leaves every other entry to the standard wording', () => {
		expect(activitySentence(entry('local-code-viewed', {}))).toEqual({ kind: 'standard' });
		expect(activitySentence(entry('sign-in', {}))).toEqual({ kind: 'standard' });
	});
});

describe('Activity wording for a share link guest (SPEC-SHARE-LINKS SL20)', () => {
	const guest = (company: string) =>
		activitySentence(
			entry('session-opened', {
				type: 'desktop',
				guest: 'Alex Smith (Acme) via a link from Jack Brumley',
				'says they are': 'Alex Smith',
				...(company === '' ? {} : { company }),
				'shared by': 'Jack Brumley',
				from: '203.0.113.5'
			})
		);

	it('SL20: says who the guest says they are, from where, and who shared the link', () => {
		expect(guest('Acme')).toEqual({
			kind: 'machine',
			text: 'Someone who says they are Alex Smith (Acme) connected to mint through a share link from 203.0.113.5, shared by Jack Brumley',
			warning: false
		});
		expect(guest('')).toMatchObject({
			text: 'Someone who says they are Alex Smith connected to mint through a share link from 203.0.113.5, shared by Jack Brumley'
		});
	});

	it("a person's own session keeps the standard wording", () => {
		expect(activitySentence(entry('session-opened', { type: 'desktop' }))).toEqual({
			kind: 'standard'
		});
	});
});
