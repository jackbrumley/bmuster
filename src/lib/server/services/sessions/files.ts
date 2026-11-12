import type { z } from 'zod';
import type { FileErrorCode } from '#lib/domain/files/files.ts';
import { UPLOAD_CHUNK_BYTES } from '#lib/domain/files/files.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import { maxUploadBytes } from '#lib/domain/settings/settings-definitions.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AuditKind } from '#lib/domain/activity/activity.ts';
import {
	deleteReplySchema,
	emptyReplySchema,
	listingReplySchema,
	partReplySchema,
	pathReplySchema,
	rootsReplySchema,
	uploadEndReplySchema
} from '#lib/schemas/files/files.ts';
import type { AppDatabase } from '../../database/connection.ts';
import type { Grant } from '#lib/domain/access/access.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected, sendToAgent } from '../agents/live-agents.ts';
import { unreachableMessage } from '../agents/presence.ts';
import { serverKey } from '../agents/server-keys.ts';
import { recordAudit } from '../audit/audit.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import { getSetting } from '../settings/settings.ts';
import type { AgentAnswer, FilesChannel, FilesChannels, FilesOp } from './files-channel.ts';
import type { Relay, SessionRecord } from './relay.ts';
import { auditSessionEnded, auditSessionOpened } from './session-audit.ts';
import { signTicket, TICKET_LIFETIME_MS } from './session-ticket.ts';
import { MAX_SESSIONS_PER_PERSON } from './sessions.ts';

/**
 * File actions (SPEC-FILES). Every request checks `view` and `files`
 * through the access service (F1: on every request, not only when the
 * session opened), then runs on the person's files session with the
 * machine. Changes are audited (F8); listing is not.
 */

export type FilesContext = {
	database: AppDatabase;
	relay: Relay;
	channels: FilesChannels;
	secretsKey: Buffer;
	user: ConsoleUser;
	machineId: string;
	ip: string;
	now: number;
};

export type FilesRefusal = { kind: 'refused'; status: number; message: string };
export type FilesOutcome<T> = { kind: 'ok'; value: T } | FilesRefusal;

/** How long the agent has to answer, by how much work the request is. */
export const ANSWER_MS = {
	quick: 30_000,
	chunk: 120_000,
	/** Deleting a big folder, or hashing a 10 GB upload. */
	slow: 15 * 60_000
} as const;

function refused(status: number, message: string): FilesRefusal {
	return { kind: 'refused', status, message };
}

/** The HTTP status for an agent's refusal. */
function statusFor(code: FileErrorCode): number {
	switch (code) {
		case 'invalid':
			return 400;
		case 'not-found':
			return 404;
		case 'exists':
		case 'not-empty':
			return 409;
		// The upload's client asks again where to carry on.
		case 'offset':
			return 412;
		case 'denied':
			return 403;
		case 'no-space':
			return 507;
		case 'mismatch':
			return 422;
		case 'busy':
			return 503;
		case 'io':
			return 502;
	}
}

/** The agent's answer, its result read with `schema`. */
export function outcomeOf<T>(answer: AgentAnswer, schema: z.ZodType<T>): FilesOutcome<T> {
	if (answer.kind === 'error') {
		return refused(statusFor(answer.code), answer.message);
	}
	const parsed = schema.safeParse(answer.result);
	return parsed.success
		? { kind: 'ok', value: parsed.data }
		: refused(502, 'The machine sent a reply this server does not understand.');
}

/** What the files service needs of the machine. */
export type FilesMachine = { id: string; name: string; osFamily: OsFamily };

type Allowed = { machine: FilesMachine; grants: Grant[] };

/** F1: who may use Files on this machine, checked on every request. */
function allowed(context: FilesContext): FilesOutcome<Allowed> {
	const { database, user, machineId } = context;
	const grants = permissionsFor(database, user, machineId);
	const basics = activeMachineBasics(database, machineId);
	if (basics === undefined || !grants.some((grant) => grant.permission === 'view')) {
		return refused(404, 'No machine with this id.');
	}
	if (!grants.some((grant) => grant.permission === 'files')) {
		return refused(403, "You don't have permission to use files on this machine.");
	}
	if (!isAgentConnected(machineId)) {
		// 503, not 409 as for terminals: an upload waits for the machine to come back.
		return refused(503, unreachableMessage(machineId, Date.now()));
	}
	return { kind: 'ok', value: { machine: { id: machineId, ...basics }, grants } };
}

/** The person's files session with the machine, opened with a signed ticket if there is none. */
function channelFor(context: FilesContext, access: Allowed): FilesOutcome<FilesChannel> {
	const { database, relay, secretsKey, user, machineId, ip, now } = context;
	const found = context.channels.get(user.id, machineId, (local, onEnded) => {
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
				purpose: { kind: 'files' }
			},
			key.privateKey
		);
		const record: SessionRecord = {
			id: sessionId,
			machineId,
			userId: user.id,
			userName: user.name,
			kind: 'files',
			ip,
			openedAt: now
		};
		relay.startLocal(
			record,
			(ended) => {
				onEnded(ended);
				auditSessionEnded(database, ended, access.machine.name);
			},
			local
		);
		auditSessionOpened(database, record, access.machine.name);
		if (!sendToAgent(machineId, { type: 'session-open', ...signed })) {
			relay.end(sessionId, 'agent-lost', 'This machine is offline.');
			return { kind: 'refused', status: 503, message: 'This machine is offline.' };
		}
		return { kind: 'opened', sessionId };
	});
	return found.kind === 'channel'
		? { kind: 'ok', value: found.channel }
		: refused(found.status, found.message);
}

/** Checks access, finds the session, and runs `work` on it. */
export async function withChannel<T>(
	context: FilesContext,
	work: (channel: FilesChannel, machine: FilesMachine) => Promise<FilesOutcome<T>>
): Promise<FilesOutcome<T>> {
	const access = allowed(context);
	if (access.kind === 'refused') {
		return access;
	}
	const channel = channelFor(context, access.value);
	if (channel.kind === 'refused') {
		return channel;
	}
	return work(channel.value, access.value.machine);
}

async function ask<T>(
	context: FilesContext,
	op: FilesOp,
	timeoutMs: number,
	schema: z.ZodType<T>
): Promise<FilesOutcome<T>> {
	return withChannel(context, async (channel) =>
		outcomeOf(await channel.ask(op, timeoutMs), schema)
	);
}

export function auditFiles(
	context: FilesContext,
	machine: FilesMachine,
	kind: AuditKind,
	detail: Record<string, string>
): void {
	recordAudit(
		context.database,
		{
			actor: { kind: 'user', userId: context.user.id },
			kind,
			target: machine.name,
			machineId: machine.id,
			detail
		},
		Date.now()
	);
}

export function listRoots(context: FilesContext) {
	return ask(context, { op: 'roots' }, ANSWER_MS.quick, rootsReplySchema);
}

export function listFolder(context: FilesContext, path: string) {
	return ask(context, { op: 'list', path }, ANSWER_MS.quick, listingReplySchema);
}

export function newFolder(context: FilesContext, dir: string, name: string) {
	return withChannel(context, async (channel, machine) => {
		const made = outcomeOf(
			await channel.ask({ op: 'mkdir', dir, name }, ANSWER_MS.quick),
			pathReplySchema
		);
		if (made.kind === 'ok') {
			auditFiles(context, machine, 'folder-created', { path: made.value.path });
		}
		return made;
	});
}

export function renameEntry(context: FilesContext, dir: string, from: string, to: string) {
	return withChannel(context, async (channel, machine) => {
		const renamed = outcomeOf(
			await channel.ask({ op: 'rename', dir, from, to }, ANSWER_MS.quick),
			pathReplySchema
		);
		if (renamed.kind === 'ok') {
			auditFiles(context, machine, 'file-renamed', { folder: dir, from, to });
		}
		return renamed;
	});
}

/** "a, b, c and 4 more": the audit names at most 20. */
function namesText(names: readonly string[]): string {
	const shown = names.slice(0, 20).join(', ');
	return names.length > 20 ? `${shown} and ${names.length - 20} more` : shown;
}

export function deleteEntries(
	context: FilesContext,
	dir: string,
	names: string[],
	recursive: boolean
) {
	return withChannel(context, async (channel, machine) => {
		const deleted = outcomeOf(
			await channel.ask({ op: 'delete', dir, names, recursive }, ANSWER_MS.slow),
			deleteReplySchema
		);
		if (deleted.kind === 'ok' && deleted.value.removed.length > 0) {
			auditFiles(context, machine, 'files-deleted', {
				folder: dir,
				names: namesText(deleted.value.removed),
				count: String(deleted.value.removed.length),
				items: String(deleted.value.items),
				...(deleted.value.failed.length > 0
					? { 'not deleted': String(deleted.value.failed.length) }
					: {})
			});
		}
		return deleted;
	});
}

/** F6: starts or resumes an upload, within the size the setting allows. */
export async function beginUpload(
	context: FilesContext,
	request: { dir: string; name: string; size: number; replace: boolean }
) {
	const limit = getSetting(context.database, 'maxUploadGb');
	if (request.size > maxUploadBytes(limit)) {
		return refused(
			413,
			`Files bigger than ${limit} GB cannot be uploaded. An admin can change this in Settings.`
		);
	}
	return ask(context, { op: 'write-begin', ...request }, ANSWER_MS.quick, partReplySchema);
}

export async function uploadChunk(
	context: FilesContext,
	target: { dir: string; name: string; offset: number },
	data: Uint8Array
) {
	if (data.byteLength === 0 || data.byteLength > UPLOAD_CHUNK_BYTES) {
		return refused(413, 'An upload piece must hold between 1 byte and 8 MB.');
	}
	return withChannel(context, async (channel) =>
		outcomeOf(await channel.chunk(target, data, ANSWER_MS.chunk), partReplySchema)
	);
}

export function endUpload(
	context: FilesContext,
	request: { dir: string; name: string; size: number; sha256: string }
) {
	return withChannel(context, async (channel, machine) => {
		const written = outcomeOf(
			await channel.ask({ op: 'write-end', ...request }, ANSWER_MS.slow),
			uploadEndReplySchema
		);
		if (written.kind === 'ok') {
			auditFiles(context, machine, 'file-uploaded', {
				path: written.value.path,
				size: String(written.value.size),
				'sha-256': written.value.sha256
			});
		}
		return written;
	});
}

export function cancelUpload(context: FilesContext, request: { dir: string; name: string }) {
	return ask(context, { op: 'write-cancel', ...request }, ANSWER_MS.quick, emptyReplySchema);
}
