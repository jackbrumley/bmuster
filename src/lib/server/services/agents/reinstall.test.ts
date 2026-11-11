import { describe, expect, it } from 'vitest';
import { machineInventory, machineStatus, machines } from '../../database/schema.ts';
import {
	SAMPLE_INVENTORY,
	enrolFakeAgent,
	enrolWithCode,
	testDatabase,
	NO_RELEASES
} from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { addNote, listNotes } from '../machines/machine-notes.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { findMachine, listMachines, removeMachine } from '../machines/machine-views.ts';
import { toConsoleUser } from '../users/users.ts';
import { authenticateAgent } from './agent-auth.ts';
import { isRefusal } from './agent-refusal.ts';
import { recordCheckIn } from './check-in.ts';
import { createJoinCode, createReinstallCode, joinCodeStatus } from './join-codes.ts';
import { agentConnected, isAgentConnected } from './live-agents.ts';
import type { AppDatabase } from '../../database/connection.ts';

const CHECK_IN = '/agent/v1/check-in';

/** An enrolled machine with a name, a description, a note, a check-in and a reinstall code. */
async function reinstallable(database: AppDatabase) {
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const old = enrolFakeAgent(database, NOW);
	updateMachineDetails(
		database,
		old.machineId,
		{ name: 'Reception PC', description: 'Front desk' },
		admin.id,
		NOW + 1
	);
	addNote(database, old.machineId, admin, 'Spare key in the drawer', NOW + 2);
	recordCheckIn(
		database,
		{ machineId: old.machineId, checkInSeconds: 60 },
		{
			agentVersion: '0.1.0',
			uptimeSeconds: 5,
			update: { kind: 'no-launcher' as const },
			signedInUser: { kind: 'user', name: 'sarah.k' },
			load: { cpuPercent: 1, memoryUsedBytes: 1 },
			inventory: { kind: 'full', hash: 'c'.repeat(64), data: SAMPLE_INVENTORY },
			localUsers: { kind: 'unsupported' },
			checks: { kind: 'unreported' },
			storage: { kind: 'unreported' }
		},
		NOW + 3
	);
	const code = createReinstallCode(database, old.machineId, admin.id, NOW + 10);
	if (code === undefined) throw new Error('no reinstall code');
	return { admin, old, code };
}

describe('reinstall code (D9)', () => {
	it('is single use and lasts 60 minutes; only for a machine that is still there', async () => {
		const database = testDatabase();
		const { admin, old, code } = await reinstallable(database);
		expect(code.maxUses).toBe(1);
		expect(code.expiresAt.getTime()).toBe(NOW + 10 + 60 * 60_000);
		expect(createReinstallCode(database, crypto.randomUUID(), admin.id, NOW)).toBeUndefined();
		removeMachine(database, old.machineId, admin.id, NOW + 11);
		expect(createReinstallCode(database, old.machineId, admin.id, NOW + 12)).toBeUndefined();
	});

	it('takes over the same entry: same id, name, description, notes and history, with the new key', async () => {
		const database = testDatabase();
		const { admin, old, code } = await reinstallable(database);
		const before = database.select().from(machines).all();

		const fresh = enrolWithCode(database, code.code, 'rebuilt-host', NOW + 20);
		if (isRefusal(fresh)) throw new Error(fresh.message);
		expect(fresh.machineId).toBe(old.machineId);

		const rows = database.select().from(machines).all();
		expect(rows).toHaveLength(before.length);
		expect(rows[0]).toMatchObject({
			id: old.machineId,
			name: 'Reception PC',
			description: 'Front desk',
			hostname: 'rebuilt-host',
			publicKey: fresh.publicKeyBase64,
			lastRequestMs: 0,
			lastUserName: 'sarah.k',
			joinCodeId: code.id,
			enrolledAt: new Date(NOW + 20),
			removedAt: null
		});
		expect(listNotes(database, old.machineId, admin).map((note) => note.body)).toEqual([
			'Spare key in the drawer'
		]);
		// The old install's figures go; the new agent's first check-in brings its own.
		expect(database.select().from(machineStatus).all()).toEqual([]);
		expect(database.select().from(machineInventory).all()).toEqual([]);
		expect(findMachine(database, old.machineId, NOW + 20, NO_RELEASES)?.inventory).toEqual({
			kind: 'pending'
		});

		const kinds = listAudit(database, 10).map((entry) => entry.kind);
		expect(kinds).toEqual([
			'machine-reinstalled',
			'machine-description-changed',
			'machine-renamed',
			'machine-enrolled'
		]);
		expect(listAudit(database, 1)[0]).toMatchObject({
			actorUserId: null,
			target: 'Reception PC',
			detail: { hostname: 'rebuilt-host', system: 'linux (x86_64-unknown-linux-gnu)' }
		});
		expect(joinCodeStatus(database, code.id, NOW + 21)).toMatchObject({
			state: 'used-up',
			machines: [{ id: old.machineId, name: 'Reception PC', removed: false }]
		});
	});

	it('refuses the old key from then on and accepts the new one', async () => {
		const database = testDatabase();
		const { old, code } = await reinstallable(database);
		expect(
			authenticateAgent(database, old.signed('POST', CHECK_IN, '{}', NOW + 15), NOW + 15)
		).toMatchObject({ machineId: old.machineId });

		const fresh = enrolWithCode(database, code.code, 'rebuilt-host', NOW + 20);
		if (isRefusal(fresh)) throw new Error(fresh.message);

		expect(
			authenticateAgent(database, old.signed('POST', CHECK_IN, '{}', NOW + 30), NOW + 30)
		).toMatchObject({ refused: true, reason: 'bad-signature' });
		expect(
			authenticateAgent(database, fresh.signed('POST', CHECK_IN, '{}', NOW + 31), NOW + 31)
		).toEqual({ machineId: old.machineId, checkInSeconds: 60 });
	});

	it("closes the old agent's live socket as revoked", async () => {
		const database = testDatabase();
		const { old, code } = await reinstallable(database);
		const closed: { code: number; reason: string }[] = [];
		agentConnected(old.machineId, {
			send: () => undefined,
			close: (closeCode, reason) => closed.push({ code: closeCode, reason })
		});
		enrolWithCode(database, code.code, 'rebuilt-host', NOW + 20);
		expect(closed).toEqual([{ code: 4001, reason: 'revoked' }]);
		expect(isAgentConnected(old.machineId)).toBe(false);
	});

	it('works once', async () => {
		const database = testDatabase();
		const { code } = await reinstallable(database);
		enrolWithCode(database, code.code, 'rebuilt-host', NOW + 20);
		expect(enrolWithCode(database, code.code, 'third-host', NOW + 21)).toMatchObject({
			refused: true,
			reason: 'used-code'
		});
	});

	it('expires after 60 minutes', async () => {
		const database = testDatabase();
		const { code } = await reinstallable(database);
		expect(enrolWithCode(database, code.code, 'late-host', NOW + 10 + 60 * 60_000)).toMatchObject({
			refused: true,
			reason: 'expired-code'
		});
	});

	it('refuses with a plain reason when the machine was removed meanwhile, and makes nothing', async () => {
		const database = testDatabase();
		const { admin, old, code } = await reinstallable(database);
		removeMachine(database, old.machineId, admin.id, NOW + 15);
		const refused = enrolWithCode(database, code.code, 'rebuilt-host', NOW + 20);
		expect(refused).toMatchObject({ refused: true, reason: 'invalid-code' });
		expect(isRefusal(refused) ? refused.message : '').toContain('has been removed');
		expect(database.select().from(machines).all()).toHaveLength(1);
		expect(listAudit(database, 1)[0]?.kind).toBe('machine-removed');
	});

	it('leaves plain join codes making a new machine, even for the same host', async () => {
		const database = testDatabase();
		const { old } = await reinstallable(database);
		const plain = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW + 20
		);
		const second = enrolWithCode(database, plain.code, 'test-host', NOW + 21);
		if (isRefusal(second)) throw new Error(second.message);
		expect(second.machineId).not.toBe(old.machineId);
		expect(listMachines(database, NOW + 21, NO_RELEASES)).toHaveLength(2);
	});
});
