import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { deleteRule } from '../access/rules.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import { verifySignature } from '../agents/signing.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import { toConsoleUser } from '../users/users.ts';
import { createFilesChannels } from './files-channel.ts';
import { downloadFile } from './files-download.ts';
import {
	beginUpload,
	deleteEntries,
	endUpload,
	listFolder,
	listRoots,
	newFolder,
	renameEntry,
	uploadChunk,
	type FilesContext
} from './files.ts';
import { createRelay, RELAY_LIMITS, type Relay, type RelayPeer } from './relay.ts';

const SECRETS_KEY = Buffer.alloc(32, 3);
const connected: { machineId: string; peer: LivePeer }[] = [];

afterEach(() => {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
});

type Request = { id: number; op: string } & Record<string, unknown>;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A pretend agent on the machine's live socket: it opens the session's
 * socket when asked and answers file requests from a little in-memory disk.
 */
function fakeAgent(relay: Relay, machineId: string) {
	const live: ServerSocketMessage[] = [];
	const requests: Request[] = [];
	const files = new Map<string, Uint8Array>([
		['/srv/data.bin', new Uint8Array(100).map((_, i) => i)]
	]);
	const parts = new Map<string, Uint8Array>();
	let sessionId = '';
	let chunkFor: Request | undefined;

	const done = (id: number, result: unknown): void => {
		relay.agentText(sessionId, peer, JSON.stringify({ type: 'done', id, result }));
	};
	const refuse = (id: number, code: string, message: string): void => {
		relay.agentText(sessionId, peer, JSON.stringify({ type: 'error', id, code, message }));
	};
	const frame = (id: number, bytes: Uint8Array): Uint8Array => {
		const framed = new Uint8Array(4 + bytes.byteLength);
		new DataView(framed.buffer).setUint32(0, id);
		framed.set(bytes, 4);
		return framed;
	};
	const key = (request: Request): string => `${String(request['dir'])}/${String(request['name'])}`;

	function handle(request: Request): void {
		const { id } = request;
		const path = String(request['path']);
		switch (request.op) {
			case 'roots':
				done(id, {
					roots: [{ path: '/', label: 'ext4', kind: 'mount', totalBytes: 100, freeBytes: 40 }]
				});
				return;
			case 'list':
				done(id, {
					path,
					entries: [
						{
							name: 'data.bin',
							kind: 'file',
							size: 100,
							modifiedMs: 1000,
							hidden: false,
							linkTarget: null
						}
					],
					more: false
				});
				return;
			case 'stat': {
				const file = files.get(path);
				if (path === '/srv') {
					done(id, { kind: 'folder', size: 0, modifiedMs: 1000 });
				} else if (file === undefined) {
					refuse(id, 'not-found', `${path} does not exist.`);
				} else {
					done(id, { kind: 'file', size: file.byteLength, modifiedMs: 1000 });
				}
				return;
			}
			case 'mkdir':
				done(id, { path: key(request) });
				return;
			case 'rename':
				done(id, { path: `${String(request['dir'])}/${String(request['to'])}` });
				return;
			case 'delete': {
				const names = request['names'] as string[];
				done(id, { removed: names, items: names.length + 2, failed: [] });
				return;
			}
			case 'read': {
				const file = files.get(path) ?? new Uint8Array();
				const offset = Number(request['offset']);
				const data = file.subarray(offset, offset + Number(request['length']));
				for (let at = 0; at < data.byteLength; at += 30) {
					relay.fromAgent(sessionId, peer, frame(id, data.subarray(at, at + 30)));
				}
				done(id, { bytes: data.byteLength });
				return;
			}
			case 'write-begin':
				done(id, { partSize: parts.get(key(request))?.byteLength ?? 0 });
				return;
			case 'write-end': {
				const part = parts.get(key(request)) ?? new Uint8Array();
				if (sha256(part) !== request['sha256']) {
					refuse(id, 'mismatch', 'The file arrived changed.');
					return;
				}
				files.set(key(request), part);
				done(id, { path: key(request), size: part.byteLength, sha256: sha256(part) });
				return;
			}
			default:
				return;
		}
	}

	const peer: RelayPeer = {
		sendText: (text) => {
			const request = JSON.parse(text) as Request;
			requests.push(request);
			if (request.op === 'write-chunk') {
				// Its data follows straight away, in the next frame.
				chunkFor = request;
				return;
			}
			queueMicrotask(() => {
				handle(request);
			});
		},
		sendBytes: (data, sent) => {
			sent();
			const request = chunkFor;
			chunkFor = undefined;
			if (request === undefined) return;
			const before = parts.get(key(request)) ?? new Uint8Array();
			const after = new Uint8Array(before.byteLength + data.byteLength - 4);
			after.set(before);
			after.set(data.subarray(4), before.byteLength);
			parts.set(key(request), after);
			queueMicrotask(() => {
				done(request.id, { partSize: after.byteLength });
			});
		},
		pause: () => undefined,
		resume: () => undefined,
		close: () => undefined
	};

	const livePeer: LivePeer = {
		send: (message) => {
			live.push(message);
			if (message.type === 'session-open') {
				sessionId = (
					JSON.parse(Buffer.from(message.ticket, 'base64').toString('utf8')) as {
						sessionId: string;
					}
				).sessionId;
				relay.attachAgent(sessionId, machineId, peer);
			}
		},
		close: () => undefined
	};
	agentConnected(machineId, livePeer);
	connected.push({ machineId, peer: livePeer });
	return { live, requests, files, parts, sessionId: () => sessionId };
}

async function setUp(idleMs = 60_000) {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const machineId = enrolFakeAgent(database, NOW).machineId;
	const relay = createRelay(RELAY_LIMITS);
	const channels = createFilesChannels(relay, { idleMs });
	const context = (user: ConsoleUser): FilesContext => ({
		database,
		relay,
		channels,
		secretsKey: SECRETS_KEY,
		user,
		machineId,
		ip: '192.0.2.7',
		now: NOW
	});
	return { database, admin, pat, machineId, relay, context };
}

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
		expect(entries).toEqual([
			{
				kind: 'files-deleted',
				detail: { folder: '/srv', names: 'old, older', count: '2', items: '4' }
			},
			{ kind: 'file-renamed', detail: { folder: '/srv', from: 'a.txt', to: 'b.txt' } },
			{ kind: 'folder-created', detail: { path: '/srv/Reports' } },
			{
				kind: 'session-opened',
				detail: { type: 'files', 'run as': 'Administrator (root or SYSTEM)', from: '192.0.2.7' }
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
