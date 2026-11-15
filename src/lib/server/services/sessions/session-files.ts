import type { z } from 'zod';
import { UPLOAD_CHUNK_BYTES } from '#lib/domain/files/files.ts';
import { hasPermission, type Grant } from '#lib/domain/access/access.ts';
import {
	MAX_FILES_PER_DROP,
	sizeText,
	type SendTarget,
	type SessionFileErrorCode,
	type TransferRow
} from '#lib/domain/session-files/session-files.ts';
import { maxUploadBytes } from '#lib/domain/settings/settings-definitions.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import {
	agentSavedSchema,
	agentSessionFilesReplySchema,
	agentTargetSchema,
	partReplySchema as partSchema,
	sendFinishReplySchema as finishedSchema
} from '#lib/schemas/session-files/session-files.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected, sendToAgent } from '../agents/live-agents.ts';
import { unreachableMessage } from '../agents/presence.ts';
import { serverKey } from '../agents/server-keys.ts';
import { recordAudit } from '../audit/audit.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import { getSetting } from '../settings/settings.ts';
import { createChannels, type AgentAnswer, type Channel, type Channels } from './files-channel.ts';
import { sessionRelay, type Relay } from './relay.ts';
import type { SessionRecord } from './session-record.ts';
import { auditSessionEnded, auditSessionOpened } from './session-audit.ts';
import { signTicket, TICKET_LIFETIME_MS } from './session-ticket.ts';
import { MAX_SESSIONS_PER_PERSON } from './sessions.ts';
import type { Transfer, TransferStore } from './session-files-transfers.ts';

/**
 * Files sent through a desktop session (SPEC-SESSION-FILES). Every request checks `view`,
 * `files` and `desktop-control` through the access service, and that the named desktop
 * session is this person's own live control session on this machine (SF1): taking a
 * permission away stops the next chunk. The agent checks the signed ticket again and does
 * every file operation as the person on the screen. Each transfer is audited (SF18).
 */

export type SessionFilesOp =
	| { op: 'target' }
	| { op: 'send-begin'; transferId: string; name: string; size: number }
	| { op: 'send-chunk'; transferId: string; offset: number }
	| { op: 'send-end'; transferId: string; size: number; sha256: string }
	| { op: 'send-cancel'; transferId: string }
	| { op: 'send-finish'; batchId: string; transferIds: string[]; sender: string };

export type SessionFilesChannel = Channel<SessionFilesOp, SessionFileErrorCode>;
export type SessionFilesChannels = Channels<SessionFilesOp, SessionFileErrorCode>;

export type SessionFilesContext = {
	database: AppDatabase;
	relay: Relay;
	channels: SessionFilesChannels;
	transfers: TransferStore;
	secretsKey: Buffer;
	user: ConsoleUser;
	machineId: string;
	ip: string;
	now: number;
};

type Refusal = { kind: 'refused'; status: number; message: string };
export type Outcome<T> = { kind: 'ok'; value: T } | Refusal;

const ANSWER_MS = { quick: 30_000, chunk: 120_000, slow: 15 * 60_000 } as const;

function refused(status: number, message: string): Refusal {
	return { kind: 'refused', status, message };
}

function statusFor(code: SessionFileErrorCode): number {
	switch (code) {
		case 'invalid':
			return 400;
		case 'nobody':
		case 'locked':
		case 'not-owned':
			return 409;
		case 'denied':
			return 403;
		case 'too-big':
			return 413;
		case 'offset':
			return 412;
		case 'mismatch':
			return 422;
		case 'no-space':
		case 'quota':
			return 507;
		case 'busy':
			return 503;
		case 'io':
			return 502;
	}
}

type Allowed = { machineName: string; grants: Grant[] };

/** SF1: who may send files, checked on every request. */
function allowed(context: SessionFilesContext, desktopSessionId: string): Outcome<Allowed> {
	const { database, user, machineId, relay } = context;
	const grants = permissionsFor(database, user, machineId);
	const basics = activeMachineBasics(database, machineId);
	if (basics === undefined || !hasPermission(grants, 'view')) {
		return refused(404, 'No machine with this id.');
	}
	if (!hasPermission(grants, 'files') || !hasPermission(grants, 'desktop-control')) {
		return refused(
			403,
			"You don't have permission to send files to this machine. That needs Files and Control desktop."
		);
	}
	const desktop = relay.runningRecord(desktopSessionId);
	if (
		desktop?.kind !== 'desktop' ||
		desktop.mode !== 'control' ||
		desktop.userId !== user.id ||
		desktop.viewer.kind !== 'user' ||
		desktop.machineId !== machineId
	) {
		return refused(409, 'Files can be sent only while you control this screen.');
	}
	if (!isAgentConnected(machineId)) {
		return refused(503, unreachableMessage(machineId, Date.now()));
	}
	return { kind: 'ok', value: { machineName: basics.name, grants } };
}

/** The person's session-files channel to the machine, opened with a signed ticket if needed. */
function channelFor(
	context: SessionFilesContext,
	access: Allowed,
	desktopSessionId: string
): Outcome<SessionFilesChannel> {
	const { database, relay, secretsKey, user, machineId, ip, now } = context;
	// One channel per desktop session: its ticket names that session, and it ends with it.
	const found = context.channels.get(
		user.id,
		`${machineId}/${desktopSessionId}`,
		(local, onEnded) => {
			if (relay.countFor(user.id) >= MAX_SESSIONS_PER_PERSON) {
				return {
					kind: 'refused',
					status: 409,
					message: `You already have ${MAX_SESSIONS_PER_PERSON} sessions open. End one first.`
				};
			}
			const sessionId = crypto.randomUUID();
			const key = serverKey(database, secretsKey, now);
			const signed = signTicket(
				{
					sessionId,
					machineId,
					user: { id: user.id, name: user.name },
					permissions: access.grants.map((grant) => grant.permission),
					runAs: { kind: 'admin' },
					issuedAtMs: now,
					expiresAtMs: now + TICKET_LIFETIME_MS,
					purpose: { kind: 'session-files', desktopSessionId }
				},
				key.privateKey
			);
			const record: SessionRecord = {
				id: sessionId,
				machineId,
				userId: user.id,
				userName: user.name,
				viewer: { kind: 'user' },
				kind: 'session-files',
				desktopSessionId,
				ip,
				openedAt: now
			};
			relay.startLocal(
				record,
				(ended) => {
					onEnded(ended);
					auditSessionEnded(database, ended, access.machineName);
				},
				local
			);
			auditSessionOpened(database, record, access.machineName);
			if (!sendToAgent(machineId, { type: 'session-open', ...signed })) {
				relay.end(sessionId, 'agent-lost', 'This machine is offline.');
				return { kind: 'refused', status: 503, message: 'This machine is offline.' };
			}
			return { kind: 'opened', sessionId };
		}
	);
	if (found.kind === 'refused') {
		return refused(found.status, found.message);
	}
	return { kind: 'ok', value: found.channel };
}

async function withChannel<T>(
	context: SessionFilesContext,
	desktopSessionId: string,
	work: (channel: SessionFilesChannel, access: Allowed) => Promise<Outcome<T>>
): Promise<Outcome<T>> {
	const access = allowed(context, desktopSessionId);
	if (access.kind === 'refused') {
		return access;
	}
	const channel = channelFor(context, access.value, desktopSessionId);
	if (channel.kind === 'refused') {
		return channel;
	}
	return work(channel.value, access.value);
}

/** The agent's answer read with `schema`, or the refusal (machine-named where it helps). */
function outcomeOf<T>(
	answer: AgentAnswer<SessionFileErrorCode>,
	schema: z.ZodType<T>,
	machineName: string
): Outcome<T> {
	if (answer.kind === 'error') {
		const message =
			answer.code === 'nobody'
				? `Nobody is signed in on ${machineName}, so there is no Downloads folder to send to.`
				: answer.message;
		return refused(statusFor(answer.code), message);
	}
	const parsed = schema.safeParse(answer.result);
	return parsed.success
		? { kind: 'ok', value: parsed.data }
		: refused(502, 'The machine sent a reply this server does not understand.');
}

/** The last place each person's files went, per machine, for the audit. */
const places = new Map<string, { user: string; folderLabel: string }>();

function placeKey(context: SessionFilesContext): string {
	return `${context.user.id}/${context.machineId}`;
}

/** The overlay's words: who is signed in and where files go, or why they cannot be sent. */
export function sendTarget(
	context: SessionFilesContext,
	desktopSessionId: string
): Promise<Outcome<SendTarget>> {
	return withChannel<SendTarget>(context, desktopSessionId, async (channel, access) => {
		const answer = outcomeOf(
			await channel.ask({ op: 'target' }, ANSWER_MS.quick),
			agentTargetSchema,
			access.machineName
		);
		if (answer.kind === 'refused') {
			return answer.status === 409
				? { kind: 'ok', value: { kind: 'refused', message: answer.message } }
				: answer;
		}
		places.set(placeKey(context), {
			user: answer.value.user,
			folderLabel: answer.value.folderLabel
		});
		return { kind: 'ok', value: { kind: 'ready', ...answer.value } };
	});
}

/** One audit entry per finished, failed or cancelled transfer (SF18): never the contents. */
function auditTransfer(
	context: SessionFilesContext,
	machineName: string,
	transfer: Transfer,
	ended: { completed: true; savedAs: string; sha256: string } | { completed: false; reason: string }
): void {
	recordAudit(
		context.database,
		{
			actor: { kind: 'user', userId: context.user.id },
			kind: 'desktop-files',
			target: machineName,
			machineId: context.machineId,
			detail: {
				direction: transfer.direction,
				desktop: transfer.desktopSessionId,
				'signed in at the machine': transfer.place.user,
				folder: transfer.place.folderLabel,
				name: ended.completed ? ended.savedAs : transfer.name,
				...(ended.completed && ended.savedAs !== transfer.name ? { sent: transfer.name } : {}),
				size: String(transfer.size),
				bytes: String(transfer.bytes),
				completed: ended.completed ? 'yes' : 'no',
				...(ended.completed ? { 'sha-256': ended.sha256 } : { reason: ended.reason })
			}
		},
		context.now
	);
}

/** Starts or resumes one file of a drop, within the size the setting allows and 100 a drop. */
export function beginSend(
	context: SessionFilesContext,
	request: {
		desktopSessionId: string;
		batchId: string;
		transferId: string | null;
		name: string;
		size: number;
	}
): Promise<Outcome<{ transferId: string; partSize: number }>> {
	const limit = getSetting(context.database, 'maxUploadGb');
	if (request.size > maxUploadBytes(limit)) {
		return Promise.resolve(
			refused(
				413,
				`${request.name} is ${sizeText(request.size)}; files can be at most ${limit} GB (Settings → Files).`
			)
		);
	}
	const { transfers, user, machineId } = context;
	const earlier =
		request.transferId === null
			? undefined
			: transfers.find(user.id, machineId, request.transferId);
	if (request.transferId !== null && earlier === undefined) {
		return Promise.resolve(refused(404, 'That file is not being sent any more. Send it again.'));
	}
	if (
		earlier === undefined &&
		transfers.inBatch(user.id, request.batchId).length >= MAX_FILES_PER_DROP
	) {
		return Promise.resolve(refused(413, `Send at most ${MAX_FILES_PER_DROP} files at once.`));
	}
	return withChannel(context, request.desktopSessionId, async (channel, access) => {
		const transferId = earlier?.id ?? crypto.randomUUID();
		const begun = outcomeOf(
			await channel.ask(
				{ op: 'send-begin', transferId, name: request.name, size: request.size },
				ANSWER_MS.quick
			),
			partSchema,
			access.machineName
		);
		if (begun.kind === 'refused') {
			return begun;
		}
		if (earlier === undefined) {
			transfers.add({
				id: transferId,
				direction: 'to-machine',
				userId: user.id,
				machineId,
				desktopSessionId: request.desktopSessionId,
				batchId: request.batchId,
				name: request.name,
				size: request.size,
				bytes: begun.value.partSize,
				startedAt: context.now,
				endedAt: undefined,
				state: { kind: 'running' },
				place: places.get(placeKey(context)) ?? {
					user: 'the person signed in',
					folderLabel: 'Downloads'
				}
			});
		} else {
			earlier.bytes = begun.value.partSize;
		}
		return { kind: 'ok', value: { transferId, partSize: begun.value.partSize } };
	});
}

function running(context: SessionFilesContext, transferId: string): Outcome<Transfer> {
	const transfer = context.transfers.find(context.user.id, context.machineId, transferId);
	if (transfer === undefined) {
		return refused(404, 'That file is not being sent any more. Send it again.');
	}
	if (transfer.state.kind !== 'running') {
		return refused(409, 'That file is no longer being sent.');
	}
	return { kind: 'ok', value: transfer };
}

export function sendChunk(
	context: SessionFilesContext,
	target: { transferId: string; offset: number },
	data: Uint8Array
): Promise<Outcome<{ partSize: number }>> {
	if (data.byteLength === 0 || data.byteLength > UPLOAD_CHUNK_BYTES) {
		return Promise.resolve(refused(413, 'An upload piece must hold between 1 byte and 8 MB.'));
	}
	const found = running(context, target.transferId);
	if (found.kind === 'refused') {
		return Promise.resolve(found);
	}
	const transfer = found.value;
	return withChannel(context, transfer.desktopSessionId, async (channel, access) => {
		const written = outcomeOf(
			await channel.chunk({ op: 'send-chunk', ...target }, data, ANSWER_MS.chunk),
			partSchema,
			access.machineName
		);
		if (written.kind === 'ok') {
			transfer.bytes = written.value.partSize;
		}
		return written;
	});
}

export function endSend(
	context: SessionFilesContext,
	request: { transferId: string; sha256: string }
): Promise<Outcome<{ savedAs: string }>> {
	const found = running(context, request.transferId);
	if (found.kind === 'refused') {
		return Promise.resolve(found);
	}
	const transfer = found.value;
	return withChannel(context, transfer.desktopSessionId, async (channel, access) => {
		const saved = outcomeOf(
			await channel.ask(
				{ op: 'send-end', transferId: transfer.id, size: transfer.size, sha256: request.sha256 },
				ANSWER_MS.slow
			),
			agentSavedSchema,
			access.machineName
		);
		if (saved.kind === 'refused') {
			// Out of step or a lost connection: the browser tries again; anything else ends it.
			if (saved.status !== 412 && saved.status !== 502 && saved.status !== 503) {
				context.transfers.end(transfer, { kind: 'failed', message: saved.message }, context.now);
				auditTransfer(context, access.machineName, transfer, {
					completed: false,
					reason: saved.message
				});
			}
			return saved;
		}
		transfer.bytes = saved.value.size;
		context.transfers.end(transfer, { kind: 'done', savedAs: saved.value.savedAs }, context.now);
		auditTransfer(context, access.machineName, transfer, {
			completed: true,
			savedAs: saved.value.savedAs,
			sha256: saved.value.sha256
		});
		return { kind: 'ok', value: { savedAs: saved.value.savedAs } };
	});
}

/** Cancel from the browser's queue or the Transfers panel: the part file goes. */
export async function cancelSend(
	context: SessionFilesContext,
	transferId: string
): Promise<Outcome<Record<string, never>>> {
	const found = running(context, transferId);
	if (found.kind === 'refused') {
		return found;
	}
	const transfer = found.value;
	const basics = activeMachineBasics(context.database, context.machineId);
	if (context.transfers.end(transfer, { kind: 'cancelled' }, context.now)) {
		auditTransfer(context, basics?.name ?? context.machineId, transfer, {
			completed: false,
			reason: 'Cancelled'
		});
	}
	// The part file is removed if the session can still reach the machine.
	await withChannel(context, transfer.desktopSessionId, async (channel) => {
		await channel.ask({ op: 'send-cancel', transferId }, ANSWER_MS.quick);
		return { kind: 'ok', value: {} };
	});
	return { kind: 'ok', value: {} };
}

/** The drop is over: the tray notice for what was saved (phase 2: the clipboard too). */
export function finishSend(
	context: SessionFilesContext,
	batchId: string
): Promise<Outcome<{ onClipboard: boolean }>> {
	const batch = context.transfers.inBatch(context.user.id, batchId);
	const first = batch[0];
	if (first === undefined) {
		return Promise.resolve(refused(404, 'No files were sent in that drop.'));
	}
	const saved = batch.filter((transfer) => transfer.state.kind === 'done');
	return withChannel(context, first.desktopSessionId, async (channel, access) => {
		if (saved.length === 0) {
			return { kind: 'ok', value: { onClipboard: false } };
		}
		return outcomeOf(
			await channel.ask(
				{
					op: 'send-finish',
					batchId,
					transferIds: saved.map((transfer) => transfer.id),
					sender: context.user.name
				},
				ANSWER_MS.quick
			),
			finishedSchema,
			access.machineName
		);
	});
}

/** The Transfers panel: this person's transfers on this machine in the last hour. */
export function listTransfers(context: SessionFilesContext): Outcome<TransferRow[]> {
	const grants = permissionsFor(context.database, context.user, context.machineId);
	if (
		activeMachineBasics(context.database, context.machineId) === undefined ||
		!hasPermission(grants, 'view')
	) {
		return refused(404, 'No machine with this id.');
	}
	return {
		kind: 'ok',
		value: context.transfers.rows(context.user.id, context.machineId, context.now)
	};
}

/** A session-files channel with nothing running ends after this. */
const IDLE_MS = 5 * 60_000;

export function createSessionFilesChannels(
	relay: Relay,
	limits: { idleMs: number }
): SessionFilesChannels {
	return createChannels<SessionFilesOp, SessionFileErrorCode>(relay, limits, {
		replies: agentSessionFilesReplySchema,
		ioCode: 'io',
		idleMessage: 'Files were not sent through the screen for 5 minutes.'
	});
}

/** Kept on globalThis, like the relay: every copy of this module must share the channels. */
const CHANNELS_KEY = Symbol.for('bmuster.session-files-channels');

export function sessionFilesChannels(): SessionFilesChannels {
	const existing: unknown = Reflect.get(globalThis, CHANNELS_KEY);
	if (isChannels(existing)) {
		return existing;
	}
	const created = createSessionFilesChannels(sessionRelay(), { idleMs: IDLE_MS });
	Reflect.set(globalThis, CHANNELS_KEY, created);
	return created;
}

function isChannels(value: unknown): value is SessionFilesChannels {
	return (
		typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
	);
}
