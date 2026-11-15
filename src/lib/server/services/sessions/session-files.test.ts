import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { SECRETS_KEY, sha256 } from '#tests/helpers/files-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { deleteRule } from '../access/rules.ts';
import { agentConnected, agentDisconnected, type LivePeer } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import { toConsoleUser } from '../users/users.ts';
import { createRelay, RELAY_LIMITS, type Relay, type RelayPeer } from './relay.ts';
import {
	beginSend,
	cancelSend,
	createSessionFilesChannels,
	endSend,
	finishSend,
	listTransfers,
	sendChunk,
	sendTarget,
	type SessionFilesContext
} from './session-files.ts';
import { createTransferStore } from './session-files-transfers.ts';

// SPEC-SESSION-FILES: files sent through a desktop session, on the server.

const disconnects: (() => void)[] = [];
afterEach(() => {
	for (const disconnect of disconnects.splice(0)) disconnect();
});

type Request = { id: number; op: string } & Record<string, unknown>;

/** A pretend agent and user files helper: a little Downloads/BMuster in memory. */
function fakeAgent(relay: Relay, machineId: string) {
	const requests: Request[] = [];
	const tickets: Record<string, unknown>[] = [];
	const saved = new Map<string, Uint8Array>();
	const parts = new Map<string, Uint8Array>();
	const names = new Map<string, string>();
	const state = { screen: 'person' as 'person' | 'locked' | 'nobody' };
	let sessionId = '';
	let chunkFor: Request | undefined;
	const done = (id: number, result: unknown): void => {
		relay.agentText(sessionId, peer, JSON.stringify({ type: 'done', id, result }));
	};
	const refuse = (id: number, code: string, message: string): void => {
		relay.agentText(sessionId, peer, JSON.stringify({ type: 'error', id, code, message }));
	};
	const free = (name: string): string => {
		let candidate = name;
		for (let n = 2; saved.has(candidate); n += 1) candidate = `${name} (${n})`;
		return candidate;
	};
	function handle(request: Request): void {
		const { id } = request;
		const transferId = String(request['transferId']);
		if (state.screen !== 'person' && (request.op === 'target' || request.op === 'send-begin')) {
			refuse(
				id,
				state.screen,
				state.screen === 'locked'
					? 'The machine is locked. Unlock it, then send the files again.'
					: 'Nobody is signed in on this machine.'
			);
			return;
		}
		switch (request.op) {
			case 'target':
				done(id, { user: 'kim', folderLabel: 'Downloads/BMuster', free: 50 * 1024 ** 3 });
				return;
			case 'send-begin':
				names.set(transferId, String(request['name']));
				done(id, { partSize: parts.get(transferId)?.byteLength ?? 0 });
				return;
			case 'send-end': {
				const part = parts.get(transferId) ?? new Uint8Array();
				if (sha256(part) !== request['sha256']) {
					refuse(id, 'mismatch', 'report.pdf arrived changed on the way. Send it again.');
					return;
				}
				const savedAs = free(names.get(transferId) ?? '');
				saved.set(savedAs, part);
				done(id, { savedAs, size: part.byteLength, sha256: sha256(part) });
				return;
			}
			case 'send-cancel':
				parts.delete(transferId);
				done(id, {});
				return;
			case 'send-finish':
				done(id, { onClipboard: false });
				return;
			default:
				return;
		}
	}
	const peer: RelayPeer = {
		sendText: (text) => {
			const request = JSON.parse(text) as Request;
			requests.push(request);
			if (request.op === 'send-chunk') {
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
			const key = String(request['transferId']);
			const before = parts.get(key) ?? new Uint8Array();
			const after = new Uint8Array(before.byteLength + data.byteLength - 4);
			after.set(before);
			after.set(data.subarray(4), before.byteLength);
			parts.set(key, after);
			queueMicrotask(() => {
				done(request.id, { partSize: after.byteLength });
			});
		},
		pause: () => undefined,
		resume: () => undefined,
		close: () => undefined
	};
	const live: LivePeer = {
		send: (message) => {
			if (message.type === 'session-open') {
				const ticket = JSON.parse(Buffer.from(message.ticket, 'base64').toString('utf8')) as {
					sessionId: string;
				} & Record<string, unknown>;
				tickets.push(ticket);
				sessionId = ticket.sessionId;
				relay.attachAgent(sessionId, machineId, peer);
			}
		},
		close: () => undefined
	};
	agentConnected(machineId, live);
	disconnects.push(() => {
		agentDisconnected(machineId, live);
	});
	return { requests, tickets, saved, state };
}

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const machineId = enrolFakeAgent(database, NOW).machineId;
	const relay = createRelay(RELAY_LIMITS);
	const channels = createSessionFilesChannels(relay, { idleMs: 60_000 });
	const transfers = createTransferStore();
	const context = (user: ConsoleUser): SessionFilesContext => ({
		database,
		relay,
		channels,
		transfers,
		secretsKey: SECRETS_KEY,
		user,
		machineId,
		ip: '192.0.2.7',
		now: NOW
	});
	/** A desktop session of `user` on the machine, as the relay holds it. */
	const desktop = (user: ConsoleUser, mode: 'control' | 'watch'): string => {
		const id = crypto.randomUUID();
		relay.start(
			{
				id,
				machineId,
				userId: user.id,
				userName: user.name,
				viewer: { kind: 'user' },
				kind: 'desktop',
				mode,
				ip: '192.0.2.7',
				openedAt: NOW
			},
			() => undefined,
			() => undefined
		);
		return id;
	};
	return { database, admin, pat, machineId, relay, context, desktop };
}

const BATCH = '0f0e0d0c-0b0a-4908-8706-050403020100';

async function sendFile(
	context: SessionFilesContext,
	desktopSessionId: string,
	name: string,
	bytes: Uint8Array
) {
	const begun = await beginSend(context, {
		desktopSessionId,
		batchId: BATCH,
		transferId: null,
		name,
		size: bytes.byteLength
	});
	if (begun.kind !== 'ok') throw new Error(begun.message);
	const chunk = await sendChunk(context, { transferId: begun.value.transferId, offset: 0 }, bytes);
	if (chunk.kind !== 'ok') throw new Error(chunk.message);
	return {
		transferId: begun.value.transferId,
		ended: await endSend(context, { transferId: begun.value.transferId, sha256: sha256(bytes) })
	};
}

describe('who may send files through a screen', () => {
	it('SF1: needs view (404), files and control (403) and a live control session of their own (409); taking a permission away stops the next chunk', async () => {
		const { database, admin, pat, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(pat, 'control');
		expect(await sendTarget(context(pat), mine)).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Files only',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files', 'desktop-view'],
			consent: 'unattended'
		});
		expect(await sendTarget(context(pat), mine)).toMatchObject({ kind: 'refused', status: 403 });
		const { ruleId } = grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files', 'desktop-view', 'desktop-control'],
			consent: 'unattended'
		});
		// Watch-only, someone else's, or no session at all: 409.
		for (const other of [desktop(pat, 'watch'), desktop(admin, 'control'), crypto.randomUUID()]) {
			expect(await sendTarget(context(pat), other)).toMatchObject({
				kind: 'refused',
				status: 409,
				message: 'Files can be sent only while you control this screen.'
			});
		}
		expect(await sendTarget(context(pat), mine)).toEqual({
			kind: 'ok',
			value: { kind: 'ready', user: 'kim', folderLabel: 'Downloads/BMuster', free: 50 * 1024 ** 3 }
		});
		// The ticket names the desktop session and carries files and control.
		expect(agent.tickets[0]).toMatchObject({
			purpose: { kind: 'session-files', desktopSessionId: mine },
			permissions: expect.arrayContaining(['files', 'desktop-control'])
		});
		const begun = await beginSend(context(pat), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'a.txt',
			size: 4
		});
		if (begun.kind !== 'ok') throw new Error('not begun');
		deleteRule(database, admin.id, ruleId, NOW);
		expect(
			await sendChunk(
				context(pat),
				{ transferId: begun.value.transferId, offset: 0 },
				new Uint8Array(4)
			)
		).toMatchObject({ kind: 'refused', status: 403 });
		// Someone else cannot see or touch the transfer.
		expect(await cancelSend(context(admin), begun.value.transferId)).toMatchObject({
			kind: 'refused',
			status: 404
		});
	});

	it('SF11: a locked screen or nobody signed in is the overlay text, not an error', async () => {
		const { admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		agent.state.screen = 'locked';
		expect(await sendTarget(context(admin), mine)).toEqual({
			kind: 'ok',
			value: {
				kind: 'refused',
				message: 'The machine is locked. Unlock it, then send the files again.'
			}
		});
		agent.state.screen = 'nobody';
		const target = await sendTarget(context(admin), mine);
		expect(target).toMatchObject({ kind: 'ok', value: { kind: 'refused' } });
		expect(JSON.stringify(target)).toMatch(
			/Nobody is signed in on .+, so there is no Downloads folder to send to\./
		);
	});
});

describe('sending', () => {
	it('SF9: refuses a file over maxUploadGb and a 101st file in one drop before asking the machine', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		updateSetting(database, admin.id, 'maxUploadGb', 10, NOW);
		expect(
			await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: 'report.iso',
				size: 12 * 1024 ** 3
			})
		).toEqual({
			kind: 'refused',
			status: 413,
			message: 'report.iso is 12.0 GB; files can be at most 10 GB (Settings → Files).'
		});
		for (let n = 0; n < 100; n += 1) {
			const begun = await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: `f${n}.txt`,
				size: 1
			});
			expect(begun.kind).toBe('ok');
		}
		expect(
			await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: 'one-more.txt',
				size: 1
			})
		).toMatchObject({ kind: 'refused', status: 413, message: 'Send at most 100 files at once.' });
		expect(agent.requests.filter((request) => request.op === 'send-begin')).toHaveLength(100);
	});

	it('SF18: one desktop-files entry per transfer with direction, people, name, size, bytes and SHA-256; never contents', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		agent.saved.set('report.pdf', new Uint8Array([1]));
		const mine = desktop(admin, 'control');
		await sendTarget(context(admin), mine);
		const bytes = new TextEncoder().encode('secret contents');
		const { ended, transferId } = await sendFile(context(admin), mine, 'report.pdf', bytes);
		expect(ended).toEqual({ kind: 'ok', value: { savedAs: 'report.pdf (2)' } });
		const cancelled = await beginSend(context(admin), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'big.bin',
			size: 10
		});
		if (cancelled.kind !== 'ok') throw new Error('not begun');
		await cancelSend(context(admin), cancelled.value.transferId);
		expect(await finishSend(context(admin), BATCH)).toEqual({
			kind: 'ok',
			value: { onClipboard: false }
		});
		const finish = agent.requests.find((request) => request.op === 'send-finish');
		expect(finish).toMatchObject({ transferIds: [transferId], sender: admin.name });

		const entries = listAudit(database, 50).filter((entry) => entry.kind === 'desktop-files');
		expect(entries).toHaveLength(2);
		const [cancelledEntry, savedEntry] = entries;
		expect(savedEntry?.detail).toEqual({
			direction: 'to-machine',
			desktop: mine,
			'signed in at the machine': 'kim',
			folder: 'Downloads/BMuster',
			name: 'report.pdf (2)',
			sent: 'report.pdf',
			size: String(bytes.byteLength),
			bytes: String(bytes.byteLength),
			completed: 'yes',
			'sha-256': sha256(bytes)
		});
		expect(cancelledEntry?.detail).toMatchObject({
			name: 'big.bin',
			completed: 'no',
			reason: 'Cancelled'
		});
		expect(JSON.stringify(entries)).not.toContain('secret contents');
		// SF16: the Transfers panel's list, newest first, survives a reload (it is the server's).
		const listed = listTransfers(context(admin));
		expect(listed).toMatchObject({
			kind: 'ok',
			value: [
				{ name: 'big.bin', state: { kind: 'cancelled' } },
				{ name: 'report.pdf', state: { kind: 'done', savedAs: 'report.pdf (2)' } }
			]
		});
	});

	it('a file that arrives changed fails, is audited, and is not retried as if the connection dropped', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		const begun = await beginSend(context(admin), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'report.pdf',
			size: 3
		});
		if (begun.kind !== 'ok') throw new Error('not begun');
		await sendChunk(
			context(admin),
			{ transferId: begun.value.transferId, offset: 0 },
			new Uint8Array(3)
		);
		expect(
			await endSend(context(admin), { transferId: begun.value.transferId, sha256: '0'.repeat(64) })
		).toMatchObject({ kind: 'refused', status: 422 });
		expect(
			listAudit(database, 10).find((entry) => entry.kind === 'desktop-files')?.detail
		).toMatchObject({
			completed: 'no'
		});
	});
});
