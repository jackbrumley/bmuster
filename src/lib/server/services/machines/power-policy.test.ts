import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activityLabel, isAuditKind } from '#lib/domain/activity/activity.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { inventorySchema, type ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { database as appDatabase } from '#lib/server/database/app-database.ts';
import { machines } from '#lib/server/database/schema.ts';
import { enrolFakeAgent, SAMPLE_INVENTORY, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { PUT } from '../../../../routes/api/machines/[id]/power-policy/+server.ts';
import { isCrossOriginWrite } from '../../hooks/origin-check.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { removeMachine } from './machine-views.ts';
import { keepAwakeOnAc, powerPolicyOnConnect, setPowerPolicy } from './power-policy.ts';

/** An enrolled machine with the policy off (new machines start with it on, S13). */
function enrolWithPolicyOff(database: Parameters<typeof enrolFakeAgent>[0]) {
	const enrolled = enrolFakeAgent(database, NOW);
	database
		.update(machines)
		.set({ keepAwakeOnAc: false })
		.where(eq(machines.id, enrolled.machineId))
		.run();
	return enrolled;
}

/** Audit entries of the new kind only (enrolment and removal write their own). */
function policyAudit(database: Parameters<typeof listAudit>[0]) {
	return listAudit(database, 50).filter((entry) => entry.kind === 'machine-power-policy-changed');
}

function recorder(connected: boolean) {
	const sent: ServerSocketMessage[] = [];
	return {
		sent,
		send: (message: ServerSocketMessage) => {
			if (connected) sent.push(message);
			return connected;
		}
	};
}

type PolicyEvent = RequestEvent<{ id: string }, '/api/machines/[id]/power-policy'>;

function event(machineId: string, user: ConsoleUser | null, body: unknown): PolicyEvent {
	const url = new URL(`https://bmuster.test/api/machines/${machineId}/power-policy`);
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request' | 'params'> = {
		locals: { session: user === null ? { kind: 'none' } : { kind: 'signed-in', user } },
		url,
		params: { id: machineId },
		request: new Request(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', origin: url.origin },
			body: JSON.stringify(body)
		})
	};
	return partial as PolicyEvent;
}

describe('Stay awake on mains power (SPEC-STAY-AWAKE P1)', () => {
	it('P1: a change is saved, audited with the old and new value, and sent to the live agent', async () => {
		const database = testDatabase();
		const { machineId } = enrolWithPolicyOff(database);
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: null
		});
		expect(keepAwakeOnAc(database, machineId)).toBe(false);

		const live = recorder(true);
		expect(setPowerPolicy(database, machineId, admin.id, true, live.send, NOW)).toEqual({
			kind: 'saved',
			keepAwakeOnAc: true,
			delivered: true
		});
		expect(live.sent).toEqual([{ type: 'power-policy', keepAwakeOnAc: true }]);
		expect(keepAwakeOnAc(database, machineId)).toBe(true);
		const [entry] = policyAudit(database);
		expect(entry).toMatchObject({
			kind: 'machine-power-policy-changed',
			actorUserId: admin.id,
			target: 'Test machine',
			detail: { from: 'off', to: 'on' }
		});

		// The same value again changes and audits nothing, but is sent again.
		setPowerPolicy(database, machineId, admin.id, true, live.send, NOW + 1);
		expect(policyAudit(database)).toHaveLength(1);
		expect(live.sent).toHaveLength(2);

		// Offline: saved and audited, and it reaches the agent when it reconnects.
		const offline = recorder(false);
		expect(setPowerPolicy(database, machineId, admin.id, false, offline.send, NOW + 2)).toEqual({
			kind: 'saved',
			keepAwakeOnAc: false,
			delivered: false
		});
		expect(policyAudit(database)[0]?.detail).toEqual({ from: 'on', to: 'off' });
		expect(powerPolicyOnConnect(database, machineId)).toEqual({
			type: 'power-policy',
			keepAwakeOnAc: false
		});
		setPowerPolicy(database, machineId, admin.id, true, offline.send, NOW + 3);
		expect(powerPolicyOnConnect(database, machineId)).toEqual({
			type: 'power-policy',
			keepAwakeOnAc: true
		});
	});

	it('P1: unknown and removed machines are not found, and nothing is sent', async () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: null
		});
		const live = recorder(true);
		expect(setPowerPolicy(database, crypto.randomUUID(), admin.id, true, live.send, NOW)).toEqual({
			kind: 'not-found'
		});
		removeMachine(database, machineId, admin.id, NOW);
		expect(setPowerPolicy(database, machineId, admin.id, true, live.send, NOW)).toEqual({
			kind: 'not-found'
		});
		expect(live.sent).toEqual([]);
		expect(policyAudit(database)).toEqual([]);
	});

	it('P1: the endpoint is admin-only, takes only a boolean, is origin-checked and reaches the live agent', async () => {
		const { machineId } = enrolWithPolicyOff(appDatabase);
		const admin = await addTestUser(appDatabase, {
			email: `power-${crypto.randomUUID()}@example.com`,
			role: 'admin',
			password: null
		});
		const adminUser: ConsoleUser = {
			id: admin.id,
			name: admin.name,
			email: admin.email,
			role: 'admin'
		};
		const member: ConsoleUser = { id: 'm', name: 'Mo', email: 'mo@example.com', role: 'member' };

		expect((await PUT(event(machineId, null, { keepAwakeOnAc: true }))).status).toBe(401);
		expect((await PUT(event(machineId, member, { keepAwakeOnAc: true }))).status).toBe(403);
		expect(keepAwakeOnAc(appDatabase, machineId)).toBe(false);
		for (const body of [{ keepAwakeOnAc: 'yes' }, {}, { keepAwakeOnAc: true, extra: 1 }]) {
			expect((await PUT(event(machineId, adminUser, body))).status, JSON.stringify(body)).toBe(400);
		}

		const sent: string[] = [];
		const peer: LivePeer = {
			send: (message) => sent.push(JSON.stringify(message)),
			close: () => undefined
		};
		agentConnected(machineId, peer);
		try {
			const reply = await PUT(event(machineId, adminUser, { keepAwakeOnAc: true }));
			expect(reply.status).toBe(200);
			expect(await reply.json()).toEqual({ keepAwakeOnAc: true, delivered: true });
			expect(sent).toEqual(['{"type":"power-policy","keepAwakeOnAc":true}']);
		} finally {
			agentDisconnected(machineId, peer);
		}
		await expect(
			PUT(event(crypto.randomUUID(), adminUser, { keepAwakeOnAc: true }))
		).rejects.toMatchObject({ status: 404 });

		const url = new URL(`https://bmuster.test/api/machines/${machineId}/power-policy`);
		expect(
			isCrossOriginWrite(
				new Request(url, { method: 'PUT', headers: { origin: 'https://evil.example' } }),
				url
			)
		).toBe(true);
	});

	it('P1: the audit kind is known to the Activity page', () => {
		expect(isAuditKind('machine-power-policy-changed')).toBe(true);
		expect(activityLabel('machine-power-policy-changed')).toBe('Changed Stay awake on mains power');
	});

	it("reads an older agent's inventory without power as unreported", () => {
		const { power: _power, ...older } = SAMPLE_INVENTORY;
		expect(inventorySchema.parse(older).power).toEqual({ kind: 'unreported' });
		expect(inventorySchema.parse(SAMPLE_INVENTORY).power).toEqual(SAMPLE_INVENTORY.power);
		expect(
			inventorySchema.safeParse({
				...SAMPLE_INVENTORY,
				power: { ...SAMPLE_INVENTORY.power, batteryPercent: 140 }
			}).success
		).toBe(false);
	});
});
