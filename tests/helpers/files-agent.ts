import { createHash } from 'node:crypto';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import {
	agentConnected,
	agentDisconnected,
	type LivePeer
} from '#lib/server/services/agents/live-agents.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { createFilesChannels } from '#lib/server/services/sessions/files-channel.ts';
import type { FilesContext } from '#lib/server/services/sessions/files.ts';
import {
	createRelay,
	RELAY_LIMITS,
	type Relay,
	type RelayPeer
} from '#lib/server/services/sessions/relay.ts';
import { enrolFakeAgent, testDatabase } from './fake-agent.ts';
import { addTestUser, NOW } from './people.ts';

/** A machine's agent for files and storage tests (SPEC-FILES, SPEC-STORAGE). */

/** The fake agent's one scanned drive. */
export const STORAGE_DRIVE = {
	mount: '/',
	sizeBytes: 1000,
	freeBytes: 100,
	lastScan: {
		kind: 'complete',
		startedAtMs: 1,
		finishedAtMs: 2,
		scannedBytes: 800,
		usedBytes: 900,
		files: 1,
		folders: 2,
		denied: 0
	},
	scanning: { kind: 'idle' }
} as const;

const STORAGE_ROOT = {
	mount: '/',
	finishedAtMs: 2,
	bytes: 800,
	files: 1,
	ownBytes: 0,
	ownFiles: 0,
	foldedFolders: 0,
	foldedBytes: 0,
	notScannedBytes: 100,
	children: [{ name: 'srv', path: '/srv', bytes: 800, files: 1, hasChildren: false }],
	more: false
};

export const SECRETS_KEY = Buffer.alloc(32, 3);
const connected: { machineId: string; peer: LivePeer }[] = [];

/** Ends every fake agent's live socket; call it after each test. */
export function disconnectFakeAgents(): void {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
}

type Request = { id: number; op: string } & Record<string, unknown>;

export const sha256 = (bytes: Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

/**
 * A pretend agent on the machine's live socket: it opens the session's
 * socket when asked and answers file requests from a little in-memory disk,
 * and storage requests (SPEC-STORAGE) from a little scan of it.
 */
export function fakeAgent(relay: Relay, machineId: string) {
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
			case 'storage-summary':
				done(id, { drives: [STORAGE_DRIVE], problem: { kind: 'none' } });
				return;
			case 'storage-folder':
				if (path !== '/' && path !== '/srv') {
					refuse(id, 'not-found', 'The last scan has no separate total for this folder.');
					return;
				}
				done(id, { ...STORAGE_ROOT, path, offset: request['offset'] });
				return;
			case 'storage-largest':
				done(id, { files: [{ path: '/srv/data.bin', bytes: 100, modifiedMs: 1000 }] });
				return;
			case 'storage-rescan':
				done(id, {});
				return;
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

/** A database with an admin and a member, an enrolled machine, a relay and its files sessions. */
export async function setUpFiles(idleMs = 60_000) {
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
