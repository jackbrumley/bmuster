import { afterEach, describe, expect, it } from 'vitest';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	disconnectFakeAgents,
	fakeAgent,
	setUpFiles,
	STORAGE_DRIVE
} from '#tests/helpers/files-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { deleteRule } from '../access/rules.ts';
import { listAudit } from '../audit/audit.ts';
import { requestRescan, storageFolder, storageLargest, storageSummary } from './storage.ts';

afterEach(disconnectFakeAgents);

describe('who may read storage (SPEC-STORAGE S9)', () => {
	it('admins always; members only with view and files, checked again on every request', async () => {
		const { database, admin, pat, machineId, relay, context } = await setUpFiles();
		fakeAgent(relay, machineId);
		expect(await storageSummary(context(admin))).toEqual({
			kind: 'ok',
			value: { drives: [STORAGE_DRIVE], problem: { kind: 'none' } }
		});
		expect(await storageSummary(context(pat))).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Viewers',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view'],
			consent: 'unattended'
		});
		expect(await storageFolder(context(pat), '/', '/', 0)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		const { ruleId } = grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files'],
			consent: 'unattended'
		});
		expect((await storageFolder(context(pat), '/', '/', 0)).kind).toBe('ok');
		deleteRule(database, admin.id, ruleId, NOW);
		expect(await storageLargest(context(pat), '/', '/')).toMatchObject({
			kind: 'refused',
			status: 403
		});
	});

	it('refuses an offline machine', async () => {
		const { admin, context } = await setUpFiles();
		expect(await storageSummary(context(admin))).toMatchObject({ kind: 'refused', status: 503 });
	});

	it('runs on the files session, with a files ticket', async () => {
		const { admin, machineId, relay, context } = await setUpFiles();
		const agent = fakeAgent(relay, machineId);
		await storageSummary(context(admin));
		const folder = await storageFolder(context(admin), '/', '/srv', 200);
		expect(folder).toMatchObject({ kind: 'ok', value: { path: '/srv', offset: 200 } });
		expect(await storageLargest(context(admin), '/', '/srv')).toEqual({
			kind: 'ok',
			value: { files: [{ path: '/srv/data.bin', bytes: 100, modifiedMs: 1000 }] }
		});
		expect(agent.live.filter((message) => message.type === 'session-open')).toHaveLength(1);
		expect(agent.requests.map((request) => request.op)).toEqual([
			'storage-summary',
			'storage-folder',
			'storage-largest'
		]);
		expect(relay.inUse(machineId)).toEqual([{ kind: 'files', userName: admin.name }]);
	});

	it('passes on the agent’s refusal of a folder the scan does not hold', async () => {
		const { admin, machineId, relay, context } = await setUpFiles();
		fakeAgent(relay, machineId);
		expect(await storageFolder(context(admin), '/', '/var/tmp', 0)).toMatchObject({
			kind: 'refused',
			status: 404
		});
	});

	it('audits Rescan now, and never reading', async () => {
		const { database, admin, machineId, relay, context } = await setUpFiles();
		fakeAgent(relay, machineId);
		await storageSummary(context(admin));
		await storageFolder(context(admin), '/', '/', 0);
		expect(await requestRescan(context(admin))).toEqual({ kind: 'ok', value: {} });
		const kinds = listAudit(database, 10).map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === 'storage-rescan-requested')).toHaveLength(1);
		expect(kinds.filter((kind) => kind.startsWith('file'))).toEqual([]);
	});
});
