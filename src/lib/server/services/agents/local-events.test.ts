import { describe, expect, it } from 'vitest';
import { activitySentence } from '#lib/domain/activity/local-page-activity.ts';
import type { LocalEventsReport } from '#lib/schemas/agents/agent-protocol.ts';
import { localEventsReportSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { enrolFakeAgent, enrolWithCode, testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { listAudit } from '../audit/audit.ts';
import { activityFeed } from '../users/activity-feed.ts';
import { insertUser } from '../users/users.ts';
import { isRefusal } from './agent-refusal.ts';
import { createReinstallCode } from './join-codes.ts';
import { recordLocalEvents } from './local-events.ts';

function addAdmin(database: AppDatabase, name: string, email: string) {
	return insertUser(database, { name, email, role: 'admin', passwordHash: null }, NOW);
}

function feedText(database: AppDatabase): string[] {
	return activityFeed(database, { kind: 'all' }, 50).flatMap((entry) => {
		const sentence = activitySentence(entry);
		return sentence.kind === 'local' ? [sentence.text] : [];
	});
}

describe('local page events in Activity (SPEC-AGENT-LOCAL 7)', () => {
	it("E3: names whose code signed in and what was done with it, by the server's names", () => {
		const database = testDatabase();
		const jack = addAdmin(database, 'Jack Brumley', 'jack@example.com');
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		const jacks = { kind: 'people' as const, people: [{ userId: jack.id, name: 'old name' }] };
		const recorded = recordLocalEvents(
			database,
			auth,
			{
				sentAtMs: NOW + 10_000,
				events: [
					{ seq: 1, atMs: NOW + 1000, event: { kind: 'wrong-code' } },
					{ seq: 2, atMs: NOW + 2000, event: { kind: 'signed-in', codes: jacks } },
					{ seq: 3, atMs: NOW + 3000, event: { kind: 'restarted', codes: jacks } }
				]
			},
			NOW + 10_000
		);
		expect(recorded).toBe(3);
		expect(feedText(database)).toEqual([
			"Restarted the agent from the local page on Test machine (signed in with Jack Brumley's code)",
			"Jack Brumley's code signed in to the local page on Test machine",
			'A wrong code was entered on the local page on Test machine'
		]);
		const entries = listAudit(database, 50).filter((entry) => entry.kind.startsWith('local-'));
		expect(entries.map((entry) => entry.actorUserId)).toEqual([null, null, null]);
		expect(entries[1]?.detail).toEqual({
			whose: "Jack Brumley's code",
			userIds: jack.id,
			sentIso: new Date(NOW + 10_000).toISOString()
		});
	});

	it("E2: puts each event at its own time, corrected for the agent's clock", () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		// The agent's clock is 5 minutes behind; the event happened 1 minute before it was sent.
		const agentNow = NOW - 5 * 60_000;
		recordLocalEvents(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			{
				sentAtMs: agentNow,
				events: [{ seq: 9, atMs: agentNow - 60_000, event: { kind: 'locked-out' } }]
			},
			NOW
		);
		const entry = listAudit(database, 50).find((item) => item.kind === 'local-locked-out');
		expect(entry?.at.getTime()).toBe(NOW - 60_000);
	});

	it('E2: records a resent event once, and a reinstalled agent numbers afresh', () => {
		const database = testDatabase();
		const admin = addAdmin(database, 'Ada', 'ada@example.com');
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		const report: LocalEventsReport = {
			sentAtMs: NOW,
			events: [
				{ seq: 100, atMs: NOW, event: { kind: 'wrong-code' } },
				{ seq: 101, atMs: NOW, event: { kind: 'locked-out' } }
			]
		};
		expect(recordLocalEvents(database, auth, report, NOW)).toBe(2);
		expect(recordLocalEvents(database, auth, report, NOW + 1)).toBe(0);
		expect(
			recordLocalEvents(
				database,
				auth,
				{
					...report,
					events: [...report.events, { seq: 102, atMs: NOW, event: { kind: 'wrong-code' } }]
				},
				NOW + 2
			)
		).toBe(1);

		const code = createReinstallCode(database, agent.machineId, admin.id, NOW + 3);
		if (code === undefined) throw new Error('no reinstall code');
		const fresh = enrolWithCode(database, code.code, 'rebuilt-host', NOW + 4);
		if (isRefusal(fresh)) throw new Error(fresh.message);
		expect(
			recordLocalEvents(
				database,
				auth,
				{ sentAtMs: NOW + 5, events: [{ seq: 1, atMs: NOW + 5, event: { kind: 'wrong-code' } }] },
				NOW + 5
			)
		).toBe(1);
	});

	it('E3: says how many events were lost while the queue was full, as a warning', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		recordLocalEvents(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			{ sentAtMs: NOW, events: [{ seq: 1, atMs: NOW, event: { kind: 'dropped', count: 7 } }] },
			NOW
		);
		const [entry] = activityFeed(database, { kind: 'all' }, 50).filter(
			(item) => item.kind === 'local-events-dropped'
		);
		if (entry === undefined) throw new Error('not recorded');
		expect(activitySentence(entry)).toMatchObject({
			kind: 'local',
			warning: true,
			text: '7 older local page events on Test machine were lost: the agent was offline and its queue was full'
		});
	});

	it('takes what the agent sends and refuses oversized or unknown reports', () => {
		const event = {
			seq: 1,
			atMs: NOW,
			event: {
				kind: 'move-started',
				codes: { kind: 'machine' },
				serverUrl: 'https://new.example'
			}
		};
		expect(localEventsReportSchema.safeParse({ sentAtMs: NOW, events: [event] }).success).toBe(
			true
		);
		expect(
			localEventsReportSchema.safeParse({
				sentAtMs: NOW,
				events: Array.from({ length: 101 }, () => event)
			}).success
		).toBe(false);
		expect(
			localEventsReportSchema.safeParse({
				sentAtMs: NOW,
				events: [{ ...event, event: { kind: 'formatted-disk' } }]
			}).success
		).toBe(false);
	});
});
