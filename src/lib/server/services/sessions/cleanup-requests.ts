import type { Permission } from '#lib/domain/access/access.ts';
import type { AuditKind } from '#lib/domain/activity/activity.ts';
import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import type { CleanupItemId, CleanupRun } from '#lib/domain/storage/cleanup.ts';
import {
	CLEANUP_REQUEST_LIMITS,
	itemsText,
	totalText
} from '#lib/domain/storage/cleanup-requests.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { RecheckRequest } from '#lib/schemas/auth/recheck.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { permissionsFor, visibleMachineIds } from '../access/access.ts';
import { recordAudit } from '../audit/audit.ts';
import {
	approverByMode,
	cleanupRequestedAudience,
	decidedAudience
} from '../commands/approvers.ts';
import { checkRecentSignIn } from '../commands/commands.ts';
import { publishLive } from '../live/live-events.ts';
import { serverLog } from '../logs/server-log.ts';
import {
	expiredCleanupRequestIds,
	findCleanupRequest,
	insertCleanupRequest,
	linkCleanup,
	pendingCleanupRequests,
	reopenCleanupRequest,
	settleCleanupRequest,
	type CleanupRequestRow
} from '../machines/cleanup-requests.ts';
import { findGrant, viaDetail } from '../oauth/grants.ts';
import { mcpEnabled } from '../oauth/mcp-settings.ts';
import type { McpPrincipal } from '../oauth/tokens.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';
import type { FilesChannels } from './files-channel.ts';
import type { FilesContext } from './files.ts';
import type { Relay } from './relay.ts';
import { cleanupSizesSoon, cleanupStatus, startCleanup } from './storage-cleanup.ts';

/**
 * Clean-ups an AI assistant asks for (SPEC-MCP M53–M56). **Security work:** it deletes files as
 * root or SYSTEM. The assistant can only ask, by item ids from the fixed list; nothing reaches
 * the agent until a person who holds `files` on the machine approves it in the console with a
 * recent sign-in. It then runs through the one clean-up path (SPEC-STORAGE 11) on the approver's
 * files session, one per machine, audited. The approval rules are the commands' (who decides,
 * 10-minute expiry, a note with a denial, disconnects cancel), on a request of its own.
 */

/** The server's parts every files session needs. */
type FilesDeps = { relay: Relay; channels: FilesChannels; secretsKey: Buffer; ip: string };

/** An assistant acting as `principal.user` (the MCP side). */
export type CleanupAssistantContext = FilesDeps & {
	database: AppDatabase;
	principal: McpPrincipal;
	now: number;
};

/** A person deciding in the console. */
export type CleanupDeciderContext = FilesDeps & {
	database: AppDatabase;
	user: ConsoleUser;
	/** The console session's cookie, for the recent sign-in check. */
	sessionToken: string;
	now: number;
};

export type CleanupRefusal = { kind: 'refused'; status: number; message: string };

function refused(status: number, message: string): CleanupRefusal {
	return { kind: 'refused', status, message };
}

/** A files session as `user` with the machine: the same checks as the Storage tab (F1). */
function filesAs(
	context: FilesDeps & { database: AppDatabase; now: number },
	user: ConsoleUser,
	machineId: string
): FilesContext {
	return {
		database: context.database,
		relay: context.relay,
		channels: context.channels,
		secretsKey: context.secretsKey,
		ip: context.ip,
		now: context.now,
		user,
		machineId
	};
}

export function holds(
	database: Queryable,
	user: ConsoleUser,
	machineId: string,
	permission: Permission
): boolean {
	return permissionsFor(database, user, machineId).some((grant) => grant.permission === permission);
}

function assistantOf(database: Queryable, request: CleanupRequestRow): string {
	const grant = findGrant(database, request.oauthGrantId);
	return grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant);
}

function viaOf(database: Queryable, request: CleanupRequestRow): Record<string, string> {
	const grant = findGrant(database, request.oauthGrantId);
	return grant === undefined ? {} : viaDetail(grant.assistant, grant.clientId);
}

function audit(
	database: Queryable,
	entry: {
		actorId: string;
		kind: AuditKind;
		request: Pick<CleanupRequestRow, 'id' | 'machineId' | 'machineName'> & {
			items: readonly CleanupItemId[];
		};
		detail: Record<string, string>;
	},
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.actorId },
			kind: entry.kind,
			target: entry.request.machineName,
			machineId: entry.request.machineId,
			detail: {
				request: entry.request.id,
				items: itemsText(entry.request.items),
				...entry.detail
			}
		},
		now
	);
}

/** Who may ask, and why not (M53): `ai-commands` and `files` on the machine. */
function askRefusal(
	context: CleanupAssistantContext,
	machine: { id: string; name: string }
): string | undefined {
	const { database, principal } = context;
	if (!holds(database, principal.user, machine.id, 'ai-commands')) {
		return `${machine.name} is open to AI for viewing only; a clean-up needs AI commands there. Nothing was asked.`;
	}
	if (!holds(database, principal.user, machine.id, 'files')) {
		return `A clean-up needs the Files permission on ${machine.name}, which you do not hold. Ask an admin for it. Nothing was asked.`;
	}
	return undefined;
}

/**
 * `clean_up_storage` (M53): checks, then a request waiting for approval. The items must be ones
 * the machine offers, measured now through the person's files session (as the Storage tab
 * measures them); those sizes are what the approval card shows. Nothing is started.
 */
export async function requestCleanup(
	context: CleanupAssistantContext,
	machine: { id: string; name: string },
	items: readonly CleanupItemId[],
	reason: string
): Promise<{ kind: 'requested'; requestId: string } | CleanupRefusal> {
	const { database, principal } = context;
	const why = askRefusal(context, machine);
	if (why !== undefined) {
		return refused(403, why);
	}
	const pending = pendingCleanupRequests(database);
	const waiting = pending.find((request) => request.machineId === machine.id);
	if (waiting !== undefined) {
		return refused(
			409,
			`A clean-up of ${machine.name} already waits for approval (requestId ${waiting.id}). Wait for it with get_cleanup_result before asking again.`
		);
	}
	if (
		pending.filter((request) => request.userId === principal.user.id).length >=
		CLEANUP_REQUEST_LIMITS.maxPending
	) {
		return refused(
			429,
			`${String(CLEANUP_REQUEST_LIMITS.maxPending)} clean-ups already wait for approval. Wait for a decision first.`
		);
	}
	const sizes = await cleanupSizesSoon(filesAs(context, principal.user, machine.id));
	if (sizes.kind === 'refused') {
		return sizes;
	}
	const offered = new Set(sizes.value.items.map((item) => item.id));
	const missing = items.filter((id) => !offered.has(id));
	if (missing.length > 0) {
		return refused(
			400,
			`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not offered on ${machine.name}. Use the ids get_storage lists under cleanUp.items. Nothing was asked.`
		);
	}
	const chosen = sizes.value.items.filter((item) => items.includes(item.id));
	const requestId = crypto.randomUUID();
	const now = context.now;
	database.transaction((transaction) => {
		insertCleanupRequest(transaction, {
			id: requestId,
			machineId: machine.id,
			userId: principal.user.id,
			oauthGrantId: principal.grantId,
			sizes: chosen,
			reason,
			requestedAt: now,
			expiresAt: now + ASSISTANT_RUN_LIMITS.expiresMs
		});
		audit(
			transaction,
			{
				actorId: principal.user.id,
				kind: 'storage-cleanup-requested',
				request: { id: requestId, machineId: machine.id, machineName: machine.name, items },
				detail: {
					total: totalText(chosen),
					reason,
					...viaDetail(principal.assistant, principal.clientId)
				}
			},
			now
		);
	});
	publishLive(cleanupRequestedAudience(database, requestId));
	return { kind: 'requested', requestId };
}

/** Expires one pending request whose 10 minutes are up; false when it was already decided. */
export function expireRequest(database: AppDatabase, requestId: string, now: number): boolean {
	const request = findCleanupRequest(database, requestId);
	if (request?.status !== 'pending' || request.expiresAt.getTime() > now) {
		return false;
	}
	const expired = database.transaction((transaction) => {
		if (!settleCleanupRequest(transaction, requestId, { status: 'expired' }, now)) {
			return false;
		}
		audit(
			transaction,
			{
				actorId: request.userId,
				kind: 'storage-cleanup-expired',
				request,
				detail: viaOf(transaction, request)
			},
			now
		);
		return true;
	});
	if (expired) {
		publishLive(decidedAudience(database, { id: requestId, startedBy: request.userId }));
	}
	return expired;
}

/** Every pending request past its 10 minutes (M55): every minute, and whenever one is read. */
export function expireCleanupRequests(database: AppDatabase, now: number): number {
	return expiredCleanupRequestIds(database, now).filter((id) => expireRequest(database, id, now))
		.length;
}

/** Cancels a pending request whose assistant was disconnected, or when AI access stopped (M55). */
function withdraw(database: AppDatabase, request: CleanupRequestRow, now: number): boolean {
	const grant = findGrant(database, request.oauthGrantId);
	const by =
		!mcpEnabled(database) || grant?.endedReason === 'kill-switch' ? 'kill-switch' : 'disconnect';
	const withdrawn = database.transaction((transaction) => {
		if (!settleCleanupRequest(transaction, request.id, { status: 'cancelled' }, now)) {
			return false;
		}
		audit(
			transaction,
			{
				actorId: request.userId,
				kind: 'storage-cleanup-withdrawn',
				request,
				detail: { by, ...viaOf(transaction, request) }
			},
			now
		);
		return true;
	});
	if (withdrawn) {
		publishLive(decidedAudience(database, { id: request.id, startedBy: request.userId }));
	}
	return withdrawn;
}

/** The assistant may no longer ask: AI assistants off, or its connection ended. */
function assistantGone(database: Queryable, request: CleanupRequestRow): boolean {
	return !mcpEnabled(database) || findGrant(database, request.oauthGrantId)?.endedAt !== null;
}

/** Pending requests of assistants that were disconnected or stopped (M55). */
export function settleEndedGrantCleanups(database: AppDatabase, now: number): number {
	return pendingCleanupRequests(database).filter(
		(request) => assistantGone(database, request) && withdraw(database, request, now)
	).length;
}

const EVERY_MS = 60_000;

/** Start-up: expire and settle now, then every minute (as SPEC-MCP 10.1 does for commands). */
export function scheduleCleanupRequestSweeps(database: AppDatabase): void {
	const sweep = (): void => {
		const now = Date.now();
		const expired = expireCleanupRequests(database, now);
		const settled = settleEndedGrantCleanups(database, now);
		if (expired + settled > 0) {
			serverLog(
				'info',
				'sessions',
				`AI assistant clean-up requests: ${String(expired)} expired, ${String(settled)} cancelled after a disconnect.`
			);
		}
	};
	sweep();
	setInterval(sweep, EVERY_MS).unref();
}

const NOT_FOUND = refused(404, 'No request with this id.');

/** The request, if this person may decide it: the setting lets them, and they see the machine. */
export function decidable(
	context: CleanupDeciderContext,
	requestId: string
): CleanupRequestRow | undefined {
	const request = findCleanupRequest(context.database, requestId);
	return request !== undefined &&
		approverByMode(context.database, context.user, { startedBy: request.userId }) &&
		visibleMachineIds(context.database, context.user).has(request.machineId)
		? request
		: undefined;
}

/** Why a request that is no longer pending cannot be decided. */
function alreadyDecided(database: AppDatabase, requestId: string): CleanupRefusal {
	const request = findCleanupRequest(database, requestId);
	switch (request?.status) {
		case 'expired':
			return refused(409, 'This request expired without a decision. The assistant was told.');
		case 'cancelled':
			return refused(409, 'This request was withdrawn: the assistant was disconnected.');
		case undefined:
		case 'pending':
		case 'approved':
		case 'denied':
			return refused(409, `Already decided by ${request?.decidedByName ?? 'someone else'}.`);
	}
}

/** Still waiting, after expiring it if its time passed; else why not. */
function stillPending(
	context: CleanupDeciderContext,
	request: CleanupRequestRow
): CleanupRefusal | undefined {
	expireRequest(context.database, request.id, context.now);
	return findCleanupRequest(context.database, request.id)?.status === 'pending'
		? undefined
		: alreadyDecided(context.database, request.id);
}

/** The assistant may still ask: MCP on, the connection live, AI commands and Files held (M54). */
function requesterRefusal(
	context: CleanupDeciderContext,
	request: CleanupRequestRow
): CleanupRefusal | undefined {
	if (assistantGone(context.database, request)) {
		withdraw(context.database, request, context.now);
		return refused(409, 'The assistant is no longer connected, so this request cannot run.');
	}
	const requester = findUserById(context.database, request.userId);
	if (requester?.disabledAt !== null) {
		return refused(409, 'The person the assistant acts as was disabled.');
	}
	const person = toConsoleUser(requester);
	return holds(context.database, person, request.machineId, 'ai-commands') &&
		holds(context.database, person, request.machineId, 'files')
		? undefined
		: refused(
				403,
				`${requester.name} no longer has AI commands and Files on ${request.machineName}.`
			);
}

/**
 * Approve (M54). Every check is made again here; the decision is one conditional write, so two
 * people deciding at once settle on one. The clean-up then starts on the approver's own files
 * session, so the agent sees their signed `files` ticket. A machine that refuses to start it
 * (busy, offline) leaves the request waiting.
 */
export async function approveCleanupRequest(
	context: CleanupDeciderContext,
	requestId: string,
	recheck: RecheckRequest
): Promise<{ kind: 'approved'; requestId: string; runId: string } | CleanupRefusal> {
	const request = decidable(context, requestId);
	if (request === undefined) {
		return NOT_FOUND;
	}
	const pending = stillPending(context, request);
	if (pending !== undefined) {
		return pending;
	}
	const requester = requesterRefusal(context, request);
	if (requester !== undefined) {
		return requester;
	}
	if (!holds(context.database, context.user, request.machineId, 'files')) {
		return refused(
			403,
			`You cannot use files on ${request.machineName}, so you cannot approve this. Someone who can must approve it.`
		);
	}
	const signIn = await checkRecentSignIn(context, recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	if (
		!settleCleanupRequest(
			context.database,
			requestId,
			{ status: 'approved', decidedBy: context.user.id },
			context.now
		)
	) {
		return alreadyDecided(context.database, requestId);
	}
	const started = await startCleanup(
		filesAs(context, context.user, request.machineId),
		request.items,
		{
			'requested by': request.userName,
			'asked via': assistantOf(context.database, request),
			reason: request.reason
		}
	);
	if (started.kind === 'refused') {
		reopenCleanupRequest(context.database, requestId);
		return started;
	}
	linkCleanup(context.database, requestId, started.value.runId);
	publishLive(decidedAudience(context.database, { id: requestId, startedBy: request.userId }));
	return { kind: 'approved', requestId, runId: started.value.runId };
}

/** Deny, with a note the assistant reads (M55). Nothing is deleted. */
export function denyCleanupRequest(
	context: CleanupDeciderContext,
	requestId: string,
	note: string
): { kind: 'denied'; requestId: string } | CleanupRefusal {
	const request = decidable(context, requestId);
	if (request === undefined) {
		return NOT_FOUND;
	}
	const pending = stillPending(context, request);
	if (pending !== undefined) {
		return pending;
	}
	const trimmed = note.trim();
	const denied = context.database.transaction((transaction) => {
		if (
			!settleCleanupRequest(
				transaction,
				requestId,
				{ status: 'denied', decidedBy: context.user.id, note: trimmed },
				context.now
			)
		) {
			return false;
		}
		audit(
			transaction,
			{
				actorId: context.user.id,
				kind: 'storage-cleanup-denied',
				request,
				detail: {
					'requested by': request.userName,
					'asked via': assistantOf(transaction, request),
					...(trimmed === '' ? {} : { note: trimmed })
				}
			},
			context.now
		);
		return true;
	});
	if (!denied) {
		return alreadyDecided(context.database, requestId);
	}
	publishLive(decidedAudience(context.database, { id: requestId, startedBy: request.userId }));
	return { kind: 'denied', requestId };
}

/**
 * A request as the assistant reads it (M56), only the person's own. While its clean-up runs, the
 * machine is asked for its progress through the person's files session, which also records the
 * result once it has finished (SPEC-STORAGE 11.5). `live` is that progress, when it is this run's.
 */
export async function readCleanupRequest(
	context: CleanupAssistantContext,
	requestId: string
): Promise<{ request: CleanupRequestRow; live: CleanupRun | undefined } | undefined> {
	const found = findCleanupRequest(context.database, requestId);
	if (found?.userId !== context.principal.user.id) {
		return undefined;
	}
	expireRequest(context.database, requestId, context.now);
	const request = findCleanupRequest(context.database, requestId) ?? found;
	if (request.status !== 'approved' || request.cleanupId === null || request.outcome !== null) {
		return { request, live: undefined };
	}
	const status = await cleanupStatus(filesAs(context, context.principal.user, request.machineId));
	const live =
		status.kind === 'ok' &&
		status.value.run.kind !== 'none' &&
		status.value.run.runId === request.cleanupId
			? status.value.run
			: undefined;
	return { request: findCleanupRequest(context.database, requestId) ?? request, live };
}
