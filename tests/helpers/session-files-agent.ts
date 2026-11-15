import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { enrolFakeAgent, testDatabase } from './fake-agent.ts';
import { SECRETS_KEY, sha256 } from './files-agent.ts';
import { addTestUser, NOW } from './people.ts';
import {
	agentConnected,
	agentDisconnected,
	type LivePeer
} from '#lib/server/services/agents/live-agents.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import {
	createRelay,
	RELAY_LIMITS,
	type Relay,
	type RelayPeer
} from '#lib/server/services/sessions/relay.ts';
import {
	createSessionFilesChannels,
	type SessionFilesContext
} from '#lib/server/services/sessions/session-files.ts';
import { createTransferStore } from '#lib/server/services/sessions/session-files-transfers.ts';

/**
 * A machine's agent and user files helper for files sent through a screen
 * (SPEC-SESSION-FILES): a little Downloads/BMuster and clipboard in memory.
 */

const disconnects: (() => void)[] = [];

/** Ends every fake agent's live socket; call it after each test. */
export function disconnectSessionFilesAgents(): void {
	for (const disconnect of disconnects.splice(0)) disconnect();
}

type Request = { id: number; op: string } & Record<string, unknown>;

/** A pretend agent and user files helper: a little Downloads/BMuster in memory. */
export function fakeAgent(relay: Relay, machineId: string) {
	const requests: Request[] = [];
	const tickets: Record<string, unknown>[] = [];
	const saved = new Map<string, Uint8Array>();
	const parts = new Map<string, Uint8Array>();
	const names = new Map<string, string>();
	const state = { screen: 'person' as 'person' | 'locked' | 'nobody' };
	/** What is copied on the machine: the offer, its walk and each file's bytes. */
	const copied: {
		offerId: string | undefined;
		files: { path: string; data: Uint8Array }[];
		skipped: { path: string; reason: string }[];
	} = { offerId: undefined, files: [], skipped: [] };
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
				done(id, { onClipboard: request['clipboard'] === true });
				return;
			case 'offer':
				done(id, {
					offer:
						copied.offerId === undefined
							? null
							: {
									offerId: copied.offerId,
									items: copied.files.map((file) => ({
										name: file.path,
										kind: 'file',
										size: file.data.byteLength
									})),
									count: copied.files.length,
									totalBytes: copied.files.reduce((sum, file) => sum + file.data.byteLength, 0)
								}
				});
				return;
			case 'offer-stat':
				if (request['offerId'] !== copied.offerId) {
					refuse(id, 'gone', 'Those files are no longer on the clipboard.');
					return;
				}
				done(id, {
					entries: copied.files.map((file) => ({
						path: file.path,
						size: file.data.byteLength,
						modifiedMs: 1_794_000_000_000
					})),
					skipped: copied.skipped,
					single: copied.files.length === 1 && copied.skipped.length === 0
				});
				return;
			case 'offer-read': {
				const file = copied.files[Number(request['entry'])];
				if (request['offerId'] !== copied.offerId || file === undefined) {
					refuse(id, 'gone', 'Those files are no longer on the clipboard.');
					return;
				}
				const offset = Number(request['offset']);
				const data = file.data.subarray(offset, offset + Number(request['length']));
				for (let at = 0; at < data.byteLength; at += 7) {
					const piece = data.subarray(at, at + 7);
					const framed = new Uint8Array(4 + piece.byteLength);
					new DataView(framed.buffer).setUint32(0, id);
					framed.set(piece, 4);
					relay.fromAgent(sessionId, peer, framed);
				}
				done(id, { bytes: data.byteLength });
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
	return { requests, tickets, saved, state, copied };
}

export async function setUp() {
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
