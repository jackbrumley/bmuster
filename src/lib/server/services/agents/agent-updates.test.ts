import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { STAGE_MS } from '#lib/domain/machines/agent-updates.ts';
import type { UpdateReport } from '#lib/schemas/agents/agent-protocol.ts';
import { NO_RELEASES, enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW, addTestUser } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { machineGroups } from '../../database/schema.ts';
import { createGroup, setGroupMembers } from '../access/groups.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import {
	checkInUpdate,
	earlyUpdatesGroup,
	pauseRollout,
	requestUpdates,
	resumeRollout,
	rolloutView,
	setPinned,
	updateStates
} from './agent-updates.ts';
import type { ReleaseLookup } from './releases.ts';

const RELEASE = { version: '0.2.0', size: 3, sha256: 'a'.repeat(64), signature: 'c2ln' };
const RELEASES: ReleaseLookup = (target) =>
	target === 'x86_64-unknown-linux-gnu' ? RELEASE : undefined;
const LAUNCHER: UpdateReport = { kind: 'launcher', last: { kind: 'none' } };

/** A machine with an agent 0.1.0 under its launcher, on a server offering 0.2.0. */
async function setUp(earlyGroup: boolean) {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const agent = enrolFakeAgent(database, NOW);
	if (earlyGroup) {
		const early = earlyUpdatesGroup(database);
		setGroupMembers(database, 'machine', admin.id, early.id, [agent.machineId], NOW);
	}
	return { database, admin, machineId: agent.machineId };
}

function checkIn(
	database: AppDatabase,
	machineId: string,
	report: UpdateReport,
	now: number,
	version = '0.1.0'
) {
	return checkInUpdate(database, machineId, version, report, RELEASES, now);
}

function state(database: AppDatabase, machineId: string, now: number, version = '0.1.0') {
	return updateStates(
		database,
		[{ id: machineId, target: 'x86_64-unknown-linux-gnu', agentVersion: version }],
		RELEASES,
		now
	).get(machineId);
}

describe('agent updates on the server (SPEC-AGENT-UPDATES)', () => {
	it('offers the signed build to an Early updates machine at once, and shows it as updating', async () => {
		const { database, machineId } = await setUp(true);
		expect(checkIn(database, machineId, LAUNCHER, NOW)).toEqual({ kind: 'offer', ...RELEASE });
		expect(state(database, machineId, NOW + 1000)).toEqual({ kind: 'updating', version: '0.2.0' });
		expect(rolloutView(database, '0.2.0', NOW)).toMatchObject({ stage: 'early' });
	});

	it('never offers to an agent without the launcher, and says it needs a reinstall', async () => {
		const { database, machineId } = await setUp(true);
		expect(checkIn(database, machineId, { kind: 'no-launcher' }, NOW)).toEqual({ kind: 'none' });
		expect(state(database, machineId, NOW)).toEqual({
			kind: 'available',
			version: '0.2.0',
			needsReinstall: true
		});
		expect(checkInUpdate(database, machineId, '0.1.0', LAUNCHER, NO_RELEASES, NOW)).toEqual({
			kind: 'none'
		});
	});

	it('records a rollback once, audits it, pauses the roll-out and stops offering', async () => {
		const { database, machineId } = await setUp(true);
		checkIn(database, machineId, LAUNCHER, NOW);
		const rolledBack: UpdateReport = {
			kind: 'launcher',
			last: { kind: 'rolled-back', version: '0.2.0', reason: 'no check-in in 120 s', atMs: NOW + 5 }
		};
		expect(checkIn(database, machineId, rolledBack, NOW + 10)).toEqual({ kind: 'none' });
		expect(checkIn(database, machineId, rolledBack, NOW + 20)).toEqual({ kind: 'none' });
		const kinds = listAudit(database, 50).map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === 'agent-update-rolled-back')).toHaveLength(1);
		expect(kinds).toContain('agent-rollout-paused');
		expect(rolloutView(database, '0.2.0', NOW + 20)).toMatchObject({
			paused: { kind: 'paused', by: 'system' }
		});
		expect(state(database, machineId, NOW + 20)).toEqual({
			kind: 'rolled-back',
			version: '0.2.0',
			reason: 'no check-in in 120 s'
		});
	});

	it('records an update the launcher kept', async () => {
		const { database, machineId } = await setUp(true);
		checkIn(database, machineId, LAUNCHER, NOW);
		const updated: UpdateReport = {
			kind: 'launcher',
			last: { kind: 'updated', from: '0.1.0', to: '0.2.0', atMs: NOW + 5 }
		};
		expect(checkIn(database, machineId, updated, NOW + 10, '0.2.0')).toEqual({ kind: 'none' });
		expect(state(database, machineId, NOW + 10, '0.2.0')).toEqual({ kind: 'up-to-date' });
		const entry = listAudit(database, 50).find((item) => item.kind === 'agent-updated');
		expect(entry?.detail).toEqual({ from: '0.1.0', to: '0.2.0' });
	});

	it('U8: finds the Early updates group by its built-in marker, not by its name', async () => {
		const { database, admin, machineId } = await setUp(false);
		// A group someone made can never be called Early updates; a lookalike name is ignored.
		const lookalike = createGroup(
			database,
			'machine',
			admin.id,
			{ name: 'Early updates (old)', description: '' },
			NOW
		);
		if (lookalike.kind !== 'done') throw new Error('no group');
		setGroupMembers(database, 'machine', admin.id, lookalike.id, [machineId], NOW);
		expect(earlyUpdatesGroup(database)).toMatchObject({ name: 'Early updates', machines: 0 });
		const early = earlyUpdatesGroup(database);
		database
			.update(machineGroups)
			.set({ name: 'Canaries' })
			.where(eq(machineGroups.id, early.id))
			.run();
		setGroupMembers(database, 'machine', admin.id, early.id, [machineId], NOW);
		expect(earlyUpdatesGroup(database)).toEqual({ id: early.id, name: 'Canaries', machines: 1 });
		expect(checkIn(database, machineId, LAUNCHER, NOW)).toEqual({ kind: 'offer', ...RELEASE });
		expect(rolloutView(database, '0.2.0', NOW)).toMatchObject({ stage: 'early' });
	});

	it('waits an hour for the 10% stage when the Early updates group is empty', async () => {
		const { database, machineId } = await setUp(false);
		const view = rolloutView(database, '0.2.0', NOW);
		expect(view).toMatchObject({ stage: 'tenth' });
		// Whether this one machine is in the 10% depends on its id; after another hour everyone is.
		expect(checkIn(database, machineId, LAUNCHER, NOW + STAGE_MS)).toMatchObject({ kind: 'offer' });
		expect(rolloutView(database, '0.2.0', NOW + STAGE_MS)).toMatchObject({ stage: 'all' });
	});

	it('pauses, resumes and pins, each audited; a paused or pinned machine gets nothing', async () => {
		const { database, admin, machineId } = await setUp(true);
		expect(pauseRollout(database, '0.2.0', admin.id, NOW)).toBe(true);
		expect(pauseRollout(database, '0.2.0', admin.id, NOW)).toBe(false);
		expect(checkIn(database, machineId, LAUNCHER, NOW + 1)).toEqual({ kind: 'none' });
		expect(resumeRollout(database, '0.2.0', admin.id, NOW + 2)).toBe(true);
		expect(setPinned(database, machineId, true, admin.id, NOW + 3)).toBe(true);
		expect(checkIn(database, machineId, LAUNCHER, NOW + 4)).toEqual({ kind: 'none' });
		expect(state(database, machineId, NOW + 4)).toMatchObject({ kind: 'pinned' });
		expect(setPinned(database, machineId, false, admin.id, NOW + 5)).toBe(true);
		expect(checkIn(database, machineId, LAUNCHER, NOW + 6)).toMatchObject({ kind: 'offer' });
		expect(setPinned(database, 'no-such-machine', true, admin.id, NOW)).toBe(false);
		const kinds = listAudit(database, 50).map((entry) => entry.kind);
		for (const kind of [
			'agent-rollout-paused',
			'agent-rollout-resumed',
			'agent-pinned',
			'agent-unpinned'
		] as const) {
			expect(kinds).toContain(kind);
		}
	});

	it('Update now jumps Manual mode and skips pinned machines and agents without the launcher', async () => {
		const { database, admin, machineId } = await setUp(false);
		updateSetting(database, admin.id, 'agentUpdatePolicy', 'manual', NOW);
		expect(checkIn(database, machineId, LAUNCHER, NOW + 5 * STAGE_MS)).toEqual({ kind: 'none' });

		const done = requestUpdates(database, [machineId], RELEASES, admin.id, NOW + 1);
		expect(done).toEqual({ requested: [machineId], skipped: [] });
		expect(checkIn(database, machineId, LAUNCHER, NOW + 2)).toMatchObject({ kind: 'offer' });

		setPinned(database, machineId, true, admin.id, NOW + 3);
		expect(requestUpdates(database, [machineId], RELEASES, admin.id, NOW + 4).skipped).toEqual([
			{ name: 'Test machine', reason: 'pinned' }
		]);
		setPinned(database, machineId, false, admin.id, NOW + 5);
		checkIn(database, machineId, { kind: 'no-launcher' }, NOW + 6);
		expect(requestUpdates(database, [machineId], RELEASES, admin.id, NOW + 7).skipped).toEqual([
			{ name: 'Test machine', reason: 'installed before automatic updates; reinstall it once' }
		]);
	});
});
