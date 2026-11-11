import { afterEach, describe, expect, it } from 'vitest';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	disconnectFakeAgents,
	fakeAgent,
	SECRETS_KEY,
	setUpFiles as setUp,
	sha256
} from '#tests/helpers/files-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { deleteRule } from '../access/rules.ts';
import { serverKey } from '../agents/server-keys.ts';
import { verifySignature } from '../agents/signing.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import { downloadFile } from './files-download.ts';
import {
	beginUpload,
	deleteEntries,
	endUpload,
	listFolder,
	listRoots,
	newFolder,
	renameEntry,
	uploadChunk
} from './files.ts';

afterEach(disconnectFakeAgents);

describe('who may use files (F1)', () => {
	it('admins always; members only with view and files, checked again on every request', async () => {
		const { database, admin, pat, machineId, relay, context } = await setUp();
		fakeAgent(relay, machineId);
		expect((await listRoots(context(admin))).kind).toBe('ok');
		expect(await listFolder(context(pat), '/srv')).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Viewers',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view'],
			consent: 'unattended'
		});
		expect(await listFolder(context(pat), '/srv')).toMatchObject({
			kind: 'refused',
			status: 403,
			message: "You don't have permission to use files on this machine."
		});
		const { ruleId } = grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files'],
			consent: 'unattended'
		});
		expect((await listFolder(context(pat), '/srv')).kind).toBe('ok');
		// The session stays open, but taking the permission away stops the next request.
		deleteRule(database, admin.id, ruleId, NOW);
		expect(await listFolder(context(pat), '/srv')).toMatchObject({ kind: 'refused', status: 403 });
	});

	it('refuses an offline machine', async () => {
		const { admin, context } = await setUp();
		expect(await listRoots(context(admin))).toMatchObject({
			kind: 'refused',
			status: 503,
			message: 'This machine is offline.'
		});
	});

	it('opens one session with a signed files ticket and reuses it', async () => {
		const { database, admin, machineId, relay, context } = await setUp();
		const agent = fakeAgent(relay, machineId);
		await listRoots(context(admin));
		await listFolder(context(admin), '/srv');
		const opens = agent.live.filter((message) => message.type === 'session-open');
		expect(opens).toHaveLength(1);
		const open = opens[0];
		if (open?.type !== 'session-open') throw new Error('no session-open');
		const json = Buffer.from(open.ticket, 'base64');
		const { publicKeyBase64 } = serverKey(database, SECRETS_KEY, NOW);
		expect(
			verifySignature(
				publicKeyBase64,
				Buffer.concat([Buffer.from('BMUSTER-TICKET-1\n'), json]),
				Buffer.from(open.signature, 'base64')
			)
		).toBe(true);
		const ticket = JSON.parse(json.toString('utf8')) as { purpose: unknown; permissions: string[] };
		expect(ticket.purpose).toEqual({ kind: 'files' });
		expect(ticket.permissions).toContain('files');
		expect(agent.requests.map((request) => request.op)).toEqual(['roots', 'list']);
	});
});

describe('changes are audited, listing is not (F8, F12)', () => {
	it('records folders, renames, deletes and the session, and shows the session in use', async () => {
		const { database, admin, machineId, relay, context } = await setUp();
		fakeAgent(relay, machineId);
		await listFolder(context(admin), '/srv');
		expect(relay.inUse(machineId)).toEqual([{ kind: 'files', userName: admin.name }]);
		expect(await newFolder(context(admin), '/srv', 'Reports')).toEqual({
			kind: 'ok',
			value: { path: '/srv/Reports' }
		});
		await renameEntry(context(admin), '/srv', 'a.txt', 'b.txt');
		await deleteEntries(context(admin), '/srv', ['old', 'older'], true);
		const entries = listAudit(database, 4).map((entry) => ({
			kind: entry.kind,
			detail: entry.detail
		}));
		const sessionId = entries[3]?.detail['session'] ?? '';
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(entries).toEqual([
			{
				kind: 'files-deleted',
				detail: { folder: '/srv', names: 'old, older', count: '2', items: '4' }
			},
			{ kind: 'file-renamed', detail: { folder: '/srv', from: 'a.txt', to: 'b.txt' } },
			{ kind: 'folder-created', detail: { path: '/srv/Reports' } },
			{
				kind: 'session-opened',
				detail: {
					type: 'files',
					'run as': 'Administrator (root or SYSTEM)',
					session: sessionId,
					from: '192.0.2.7'
				}
			}
		]);
	});

	it('ends an unused session and audits how it ended', async () => {
		const { database, admin, machineId, relay, context } = await setUp(20);
		fakeAgent(relay, machineId);
		await listRoots(context(admin));
		await expect.poll(() => relay.inUse(machineId)).toEqual([]);
		const ended = listAudit(database, 5).find((entry) => entry.kind === 'session-ended');
		expect(ended?.detail).toMatchObject({ type: 'files', ended: 'Files not used for 5 minutes' });
		// The next request opens a new session.
		expect((await listRoots(context(admin))).kind).toBe('ok');
	});
});

describe('uploads (F6)', () => {
	it('resume from what the machine holds, check the hash, and are audited', async () => {
		const { database, admin, machineId, relay, context } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const data = new Uint8Array(20).map((_, i) => i * 3);
		const target = { dir: '/srv', name: 'up.bin' };
		expect(await beginUpload(context(admin), { ...target, size: 20, replace: false })).toEqual({
			kind: 'ok',
			value: { partSize: 0 }
		});
		expect(
			await uploadChunk(context(admin), { ...target, offset: 0 }, data.subarray(0, 8))
		).toEqual({
			kind: 'ok',
			value: { partSize: 8 }
		});
		// The connection drops; begin again says where to carry on.
		expect(await beginUpload(context(admin), { ...target, size: 20, replace: false })).toEqual({
			kind: 'ok',
			value: { partSize: 8 }
		});
		await uploadChunk(context(admin), { ...target, offset: 8 }, data.subarray(8));
		expect(
			await endUpload(context(admin), { ...target, size: 20, sha256: sha256(new Uint8Array(20)) })
		).toMatchObject({ kind: 'refused', status: 422 });
		expect(await endUpload(context(admin), { ...target, size: 20, sha256: sha256(data) })).toEqual({
			kind: 'ok',
			value: { path: '/srv/up.bin', size: 20, sha256: sha256(data) }
		});
		expect(agent.files.get('/srv/up.bin')).toEqual(data);
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'file-uploaded',
			detail: { path: '/srv/up.bin', size: '20', 'sha-256': sha256(data) }
		});
	});

	it('refuses files over the size setting and pieces over 8 MB', async () => {
		const { database, admin, machineId, relay, context } = await setUp();
		fakeAgent(relay, machineId);
		const target = { dir: '/srv', name: 'big.iso' };
		expect(
			await beginUpload(context(admin), { ...target, size: 11 * 1024 ** 3, replace: false })
		).toMatchObject({ kind: 'refused', status: 413 });
		updateSetting(database, admin.id, 'maxUploadGb', '50', NOW);
		expect(
			(await beginUpload(context(admin), { ...target, size: 11 * 1024 ** 3, replace: false })).kind
		).toBe('ok');
		expect(
			await uploadChunk(
				context(admin),
				{ ...target, offset: 0 },
				new Uint8Array(8 * 1024 * 1024 + 1)
			)
		).toMatchObject({ kind: 'refused', status: 413 });
	});
});

describe('downloads (F5)', () => {
	const whole = new Uint8Array(100).map((_, i) => i);

	async function download(
		range: string | null,
		ifRange: string | null,
		method: 'GET' | 'HEAD' = 'GET'
	) {
		const setup = await setUp();
		fakeAgent(setup.relay, setup.machineId);
		const outcome = await downloadFile(setup.context(setup.admin), {
			path: '/srv/data.bin',
			method,
			range,
			ifRange
		});
		if (outcome.kind !== 'ok') throw new Error(outcome.message);
		return { response: outcome.value, database: setup.database };
	}

	it('streams the whole file with the headers a download manager needs, and audits its hash', async () => {
		const { response, database } = await download(null, null);
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toMatchObject({
			'accept-ranges': 'bytes',
			'content-length': '100',
			'content-disposition': `attachment; filename="data.bin"; filename*=UTF-8''data.bin`,
			'content-type': 'application/octet-stream'
		});
		expect(response.headers.get('etag')).toMatch(/^".+"$/);
		expect(response.headers.get('last-modified')).toBe(new Date(1000).toUTCString());
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(whole);
		await expect
			.poll(() => listAudit(database, 1)[0])
			.toMatchObject({
				kind: 'file-downloaded',
				detail: {
					path: '/srv/data.bin',
					size: '100',
					range: 'the whole file',
					sent: '100',
					'sha-256': sha256(whole),
					completed: 'yes'
				}
			});
	});

	it('resumes from a Range, and refuses a range past the end', async () => {
		const { response, database } = await download('bytes=40-', null);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 40-99/100');
		expect(response.headers.get('content-length')).toBe('60');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(whole.subarray(40));
		await expect
			.poll(() => listAudit(database, 1)[0]?.detail)
			.toMatchObject({ range: 'bytes 40-99', sent: '60', 'sha-256': sha256(whole.subarray(40)) });
		const past = await download('bytes=100-', null);
		expect(past.response.status).toBe(416);
		expect(past.response.headers.get('content-range')).toBe('bytes */100');
	});

	it('sends the whole file again when If-Range names another version', async () => {
		const { response } = await download('bytes=40-', '"something-else"');
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(whole);
	});

	it('answers HEAD with headers only, unaudited', async () => {
		const { response, database } = await download(null, null, 'HEAD');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('100');
		expect(response.body).toBeNull();
		expect(listAudit(database, 5).map((entry) => entry.kind)).not.toContain('file-downloaded');
	});

	it('refuses folders and missing files with the agent’s reason', async () => {
		const { admin, machineId, relay, context } = await setUp();
		fakeAgent(relay, machineId);
		const request = { method: 'GET', range: null, ifRange: null } as const;
		expect(await downloadFile(context(admin), { ...request, path: '/srv' })).toMatchObject({
			kind: 'refused',
			status: 400
		});
		expect(await downloadFile(context(admin), { ...request, path: '/srv/nope' })).toMatchObject({
			kind: 'refused',
			status: 404,
			message: '/srv/nope does not exist.'
		});
	});
});
