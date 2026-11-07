import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW } from '#tests/helpers/people.ts';
import { PRESENCE_GRACE_MS, socketClosed, socketOpened } from '../agents/presence.ts';
import { endSession, startSession } from '../auth/sessions.ts';
import { machineFeed, machineFeedStream } from './machine-feed.ts';

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
	vi.useRealTimers();
});

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: null
	});
	const member = await addTestUser(database, {
		email: 'member@example.test',
		role: 'member',
		password: null
	});
	const seen = enrolFakeAgent(database, NOW).machineId;
	const hidden = enrolFakeAgent(database, NOW).machineId;
	grantAccess(database, {
		adminId: admin.id,
		name: 'Front desk',
		memberIds: [member.id],
		machineIds: [seen],
		permissions: ['view'],
		consent: 'ask'
	});
	return {
		database,
		seen,
		hidden,
		adminToken: startSession(database, admin.id, CLIENT, NOW).token,
		memberToken: startSession(database, member.id, CLIENT, NOW).token
	};
}

describe('live machine status feed (SPEC-PRESENCE P5)', () => {
	it('sends a member only the machines they can see; an admin gets every one', async () => {
		const { database, seen, hidden, adminToken, memberToken } = await setUp();
		const toMember: MachineStatusEvent[] = [];
		const toAdmin: MachineStatusEvent[] = [];
		const stops = [
			machineFeed(database, memberToken, (event) => toMember.push(event), vi.fn()),
			machineFeed(database, adminToken, (event) => toAdmin.push(event), vi.fn())
		];
		socketOpened(database, seen, NOW);
		socketOpened(database, hidden, NOW);
		for (const stop of stops) {
			stop();
		}
		expect(toMember.map((event) => event.machineId)).toEqual([seen]);
		expect(toAdmin.map((event) => event.machineId)).toEqual([seen, hidden]);
	});

	it('ends the feed once the session has ended, sending nothing more', async () => {
		const { database, seen, memberToken } = await setUp();
		const sent: MachineStatusEvent[] = [];
		const end = vi.fn();
		machineFeed(database, memberToken, (event) => sent.push(event), end);
		socketOpened(database, seen, NOW);
		endSession(database, memberToken);
		socketClosed(database, seen, NOW);
		vi.advanceTimersByTime(PRESENCE_GRACE_MS);
		expect(sent.map((event) => event.status.kind)).toEqual(['online']);
		expect(end).toHaveBeenCalledOnce();
	});

	it('streams server-sent events: a retry delay, then each visible change', async () => {
		const { database, seen, hidden, memberToken } = await setUp();
		const reader = machineFeedStream(database, memberToken).getReader();
		socketOpened(database, hidden, NOW);
		socketOpened(database, seen, NOW);
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		for (let index = 0; index < 2; index += 1) {
			const { value } = await reader.read();
			chunks.push(decoder.decode(value));
		}
		await reader.cancel();
		expect(chunks).toEqual([
			'retry: 5000\n\n',
			`event: status\ndata: ${JSON.stringify({
				machineId: seen,
				status: { kind: 'online' },
				atIso: new Date(NOW).toISOString()
			})}\n\n`
		]);
	});
});
