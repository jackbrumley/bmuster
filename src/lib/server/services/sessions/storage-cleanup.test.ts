import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { grantAccess } from '#tests/helpers/access.ts';
import { disconnectFakeAgents, fakeAgent, setUpFiles } from '#tests/helpers/files-agent.ts';
import { cleanupStartRequestSchema } from '#lib/schemas/storage/cleanup.ts';
import type { CleanupItemProgress, CleanupRun } from '#lib/domain/storage/cleanup.ts';
import { storageCleanups } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { recordCleanupResult } from '../machines/storage-cleanups.ts';
import { requestRescan } from './storage.ts';
import { cleanupSizes, cleanupStatus, startCleanup } from './storage-cleanup.ts';

afterEach(disconnectFakeAgents);

const DONE: CleanupItemProgress[] = [
	{
		id: 'old-var-tmp',
		state: {
			kind: 'done',
			result: {
				freedBytes: 2048,
				measured: 'counted',
				filesRemoved: 3,
				filesSkipped: 1,
				errors: 0,
				messages: []
			}
		}
	}
];

function finished(runId: string): CleanupRun {
	return { kind: 'finished', runId, startedAtMs: 1, finishedAtMs: 2, items: DONE };
}

describe('who may clean up (SPEC-STORAGE S19)', () => {
	it('needs view and files on the machine, checked on every request', async () => {
		const { database, admin, pat, machineId, relay, context } = await setUpFiles();
		const agent = fakeAgent(relay, machineId);
		expect(await cleanupSizes(context(pat))).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Viewers',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view'],
			consent: 'unattended'
		});
		expect(await startCleanup(context(pat), ['old-var-tmp'])).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(await cleanupStatus(context(pat))).toMatchObject({ kind: 'refused', status: 403 });
		expect(agent.requests).toEqual([]);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files'],
			consent: 'unattended'
		});
		expect(await cleanupSizes(context(pat))).toMatchObject({
			kind: 'ok',
			value: { items: [{ id: 'old-var-tmp' }, { id: 'unused-flatpaks' }] }
		});
		expect(agent.live.filter((message) => message.type === 'session-open')).toHaveLength(1);
	});

	it('refuses an offline machine', async () => {
		const { admin, context } = await setUpFiles();
		expect(await startCleanup(context(admin), ['old-var-tmp'])).toMatchObject({
			kind: 'refused',
			status: 503
		});
	});

	it('takes item ids only, each once, nothing else', () => {
		expect(cleanupStartRequestSchema.safeParse({ items: ['old-var-tmp'] }).success).toBe(true);
		for (const body of [
			{ items: [] },
			{ items: ['/var/tmp'] },
			{ items: ['old-var-tmp', 'old-var-tmp'] },
			{ items: ['old-var-tmp'], path: '/etc' },
			{ items: 'old-var-tmp' }
		]) {
			expect(cleanupStartRequestSchema.safeParse(body).success).toBe(false);
		}
	});
});

describe('a clean-up run (SPEC-STORAGE S19)', () => {
	it('sends ids with a new run id, records the start and audits it', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		const agent = fakeAgent(relay, machineId);
		const started = await startCleanup(context(admin), ['old-var-tmp', 'journal']);
		if (started.kind !== 'ok') throw new Error(started.message);
		const request = agent.requests.find((sent) => sent.op === 'storage-cleanup-start');
		expect(request).toMatchObject({
			runId: started.value.runId,
			items: ['old-var-tmp', 'journal']
		});
		expect(Object.keys(request ?? {}).sort()).toEqual(['id', 'items', 'op', 'runId']);
		const row = database
			.select()
			.from(storageCleanups)
			.where(eq(storageCleanups.id, started.value.runId))
			.get();
		expect(row).toMatchObject({ machineId, userId: admin.id, finishedAt: null });
		const [entry] = listAudit(database, 1);
		expect(entry).toMatchObject({
			kind: 'storage-cleanup-started',
			detail: { items: 'Old files in /var/tmp, System journal over 200 MB' }
		});
	});

	it('passes on the machine refusing a second clean-up, and records nothing', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		fakeAgent(relay, machineId);
		expect((await startCleanup(context(admin), ['old-var-tmp'])).kind).toBe('ok');
		expect(await startCleanup(context(admin), ['old-var-tmp'])).toMatchObject({
			kind: 'refused',
			status: 503
		});
		expect(database.select().from(storageCleanups).all()).toHaveLength(1);
	});

	it('records and audits the result once, as the person who started it', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		const agent = fakeAgent(relay, machineId);
		const started = await startCleanup(context(admin), ['old-var-tmp']);
		if (started.kind !== 'ok') throw new Error(started.message);
		expect(await cleanupStatus(context(admin))).toMatchObject({
			kind: 'ok',
			value: { run: { kind: 'running' } }
		});
		agent.state.cleanupRun = finished(started.value.runId);
		await cleanupStatus(context(admin));
		await cleanupStatus(context(admin));
		const entries = listAudit(database, 10).filter((entry) => entry.kind === 'storage-cleanup');
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorUserId: admin.id,
			detail: { items: 'Old files in /var/tmp', freed: '2.0 KB', 'files removed': '3' }
		});
		// The check-in carries the same run: nothing more.
		expect(recordCleanupResult(database, machineId, finished(started.value.runId), 3)).toBe(false);
	});

	it('ignores a run id of another machine', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		fakeAgent(relay, machineId);
		const started = await startCleanup(context(admin), ['old-var-tmp']);
		if (started.kind !== 'ok') throw new Error(started.message);
		expect(
			recordCleanupResult(database, crypto.randomUUID(), finished(started.value.runId), 3)
		).toBe(false);
		expect(recordCleanupResult(database, machineId, finished(crypto.randomUUID()), 3)).toBe(false);
		expect(recordCleanupResult(database, machineId, finished(started.value.runId), 3)).toBe(true);
	});
});

describe('Rescan now says when a scan is already running (SPEC-STORAGE S26)', () => {
	it('an older agent’s empty answer means asked; already scanning is not audited', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		const agent = fakeAgent(relay, machineId);
		expect(await requestRescan(context(admin))).toEqual({
			kind: 'ok',
			value: { alreadyScanning: false }
		});
		agent.state.rescanReply = { alreadyScanning: true };
		expect(await requestRescan(context(admin))).toEqual({
			kind: 'ok',
			value: { alreadyScanning: true }
		});
		const kinds = listAudit(database, 10).map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === 'storage-rescan-requested')).toHaveLength(1);
	});
});
