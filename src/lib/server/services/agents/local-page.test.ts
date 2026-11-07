import { describe, expect, it } from 'vitest';
import { machineLocalPages } from '../../database/schema.ts';
import { enrolFakeAgent, enrolWithCode, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { totpCode } from '../../crypto/totp.ts';
import { listAudit } from '../audit/audit.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { isRefusal } from './agent-refusal.ts';
import { createReinstallCode } from './join-codes.ts';
import { localPageInfo, storeLocalPage, viewLocalCode } from './local-page.ts';
import type { AppDatabase } from '../../database/connection.ts';

const KEY = Buffer.alloc(32, 5);
const SECRET = Buffer.from('12345678901234567890', 'ascii');
const CERTIFICATE_SHA256 = 'ab'.repeat(32);

async function reported(database: AppDatabase) {
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const agent = enrolFakeAgent(database, NOW);
	storeLocalPage(
		database,
		{ machineId: agent.machineId, checkInSeconds: 60 },
		{ totpSecret: SECRET.toString('base64'), certificateSha256: CERTIFICATE_SHA256, port: 47500 },
		KEY,
		NOW + 1
	);
	return { admin, agent };
}

function codeViews(database: AppDatabase) {
	return listAudit(database, 50).filter((entry) => entry.kind === 'local-code-viewed');
}

describe('the local page in the console (SPEC-AGENT-LOCAL)', () => {
	it('keeps the secret sealed and shows the address and the fingerprint', async () => {
		const database = testDatabase();
		const { agent } = await reported(database);
		const row = database.select().from(machineLocalPages).get();
		expect(row?.totpSecretSealed).toMatch(/^v1\./);
		expect(row?.totpSecretSealed).not.toContain(SECRET.toString('base64'));
		expect(localPageInfo(database, agent.machineId)).toEqual({
			kind: 'reported',
			address: 'https://localhost:47500',
			fingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
			reportedIso: new Date(NOW + 1).toISOString()
		});
	});

	it('says plainly when an older agent has sent no secret', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const agent = enrolFakeAgent(database, NOW);
		expect(localPageInfo(database, agent.machineId)).toEqual({ kind: 'none' });
		expect(viewLocalCode(database, agent.machineId, admin.id, KEY, NOW)).toEqual({
			kind: 'not-reported'
		});
		expect(codeViews(database)).toEqual([]);
	});

	it("gives the agent's current code and the seconds until it changes", async () => {
		const database = testDatabase();
		const { admin, agent } = await reported(database);
		const at = 1_794_000_010_000; // 10 s into a 30-second step
		expect(viewLocalCode(database, agent.machineId, admin.id, KEY, at)).toEqual({
			kind: 'code',
			code: totpCode(SECRET, at / 1000),
			secondsLeft: 20
		});
	});

	it('audits a view at most once a minute per admin and machine', async () => {
		const database = testDatabase();
		const { admin, agent } = await reported(database);
		const other = await addTestUser(database, {
			email: 'bo@example.com',
			role: 'admin',
			password: null
		});
		for (const offset of [0, 30_000, 59_999]) {
			viewLocalCode(database, agent.machineId, admin.id, KEY, NOW + 10 + offset);
		}
		expect(codeViews(database)).toHaveLength(1);
		expect(codeViews(database)[0]).toMatchObject({
			actorUserId: admin.id,
			target: 'Test machine',
			detail: { hostname: 'test-host' }
		});
		viewLocalCode(database, agent.machineId, other.id, KEY, NOW + 20);
		expect(codeViews(database)).toHaveLength(2);
		viewLocalCode(database, agent.machineId, admin.id, KEY, NOW + 10 + 60_000);
		expect(codeViews(database)).toHaveLength(3);
	});

	it('has no code for an unknown or removed machine', async () => {
		const database = testDatabase();
		const { admin, agent } = await reported(database);
		expect(viewLocalCode(database, crypto.randomUUID(), admin.id, KEY, NOW)).toBeUndefined();
		removeMachine(database, agent.machineId, admin.id, NOW + 2);
		expect(viewLocalCode(database, agent.machineId, admin.id, KEY, NOW + 3)).toBeUndefined();
	});

	it('replaces a report, and a reinstall forgets the old one', async () => {
		const database = testDatabase();
		const { admin, agent } = await reported(database);
		storeLocalPage(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			{ totpSecret: SECRET.toString('base64'), certificateSha256: 'cd'.repeat(32), port: 47501 },
			KEY,
			NOW + 2
		);
		expect(database.select().from(machineLocalPages).all()).toHaveLength(1);
		expect(localPageInfo(database, agent.machineId)).toMatchObject({
			address: 'https://localhost:47501'
		});

		const code = createReinstallCode(database, agent.machineId, admin.id, NOW + 3);
		if (code === undefined) throw new Error('no reinstall code');
		const fresh = enrolWithCode(database, code.code, 'rebuilt-host', NOW + 4);
		if (isRefusal(fresh)) throw new Error(fresh.message);
		expect(localPageInfo(database, agent.machineId)).toEqual({ kind: 'none' });
	});
});
