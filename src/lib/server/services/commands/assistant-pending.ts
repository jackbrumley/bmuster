import type { AppDatabase } from '../../database/connection.ts';
import { publishLive } from '../live/live-events.ts';
import { serverLog } from '../logs/server-log.ts';
import { findGrant, viaDetail } from '../oauth/grants.ts';
import { decidedAudience } from './approvers.ts';
import { auditRunCancelled, auditRunExpired, type CancelledBy } from './command-audit.ts';
import type { CommandRunner } from './command-runner.ts';
import {
	cancelWaiting,
	expiredPendingRunIds,
	findRun,
	machinesOf,
	openAssistantRuns,
	setRunStatus,
	settlePending,
	type RunRow
} from './command-runs.ts';

/**
 * How an AI assistant's request ends without running (SPEC-MCP M21, M29): it expires 10 minutes
 * after it was made, the assistant withdraws it, a person cancels it, its assistant is
 * disconnected, or an admin stops all AI access. Each ending is one conditional write, so it
 * races approve and deny safely; listeners and the open consoles hear of it.
 */

export type PendingContext = { database: AppDatabase; runner: CommandRunner; now: number };

function viaOfRun(context: PendingContext, run: RunRow): Record<string, string> {
	const grant =
		run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
	return grant === undefined ? {} : viaDetail(grant.assistant, grant.clientId);
}

function machineNames(context: PendingContext, runId: string): string[] {
	return machinesOf(context.database, [runId]).map((machine) => machine.machineName);
}

function announce(context: PendingContext, run: RunRow): void {
	context.runner.announce(run.id);
	publishLive(decidedAudience(context.database, run));
}

/** Expires one pending run whose time has passed; false when it was already decided. */
export function expireRun(context: PendingContext, runId: string): boolean {
	const run = findRun(context.database, runId);
	if (
		run?.status !== 'pending-approval' ||
		run.expiresAt === null ||
		run.expiresAt.getTime() > context.now
	) {
		return false;
	}
	const expired = context.database.transaction((transaction) => {
		if (!settlePending(transaction, runId, { status: 'expired' }, context.now)) {
			return false;
		}
		cancelWaiting(transaction, runId, context.now);
		auditRunExpired(
			transaction,
			{
				runId,
				userId: run.startedBy,
				machineNames: machineNames(context, runId),
				via: viaOfRun(context, run)
			},
			context.now
		);
		return true;
	});
	if (expired) {
		announce(context, run);
	}
	return expired;
}

/** Every pending run past its 10 minutes (M21): at start-up, every minute, and when read. */
export function expirePendingRuns(context: PendingContext): number {
	return expiredPendingRunIds(context.database, context.now).filter((runId) =>
		expireRun(context, runId)
	).length;
}

/**
 * Cancels a run waiting for approval: nothing runs. `actorId` is the person in the audit entry
 * (the person the assistant acts as, unless someone else cancelled it). False when it was no
 * longer pending.
 */
export function cancelPendingRun(
	context: PendingContext,
	run: RunRow,
	by: CancelledBy,
	actorId: string
): boolean {
	const cancelled = context.database.transaction((transaction) => {
		if (!settlePending(transaction, run.id, { status: 'cancelled' }, context.now)) {
			return false;
		}
		const notStarted = cancelWaiting(transaction, run.id, context.now);
		auditRunCancelled(
			transaction,
			{
				runId: run.id,
				userId: actorId,
				notStarted,
				by,
				via: by === 'assistant' ? viaOfRun(context, run) : {}
			},
			context.now
		);
		return true;
	});
	if (cancelled) {
		announce(context, run);
	}
	return cancelled;
}

/** C17 for a started run: machines not started are cancelled; running ones finish. */
export function cancelStartedRun(
	context: PendingContext,
	run: RunRow,
	by: CancelledBy,
	actorId: string
): number {
	const notStarted = context.database.transaction((transaction) => {
		const count = cancelWaiting(transaction, run.id, context.now);
		setRunStatus(transaction, run.id, 'cancelled');
		auditRunCancelled(
			transaction,
			{
				runId: run.id,
				userId: actorId,
				notStarted: count,
				by,
				via: by === 'assistant' ? viaOfRun(context, run) : {}
			},
			context.now
		);
		return count;
	});
	context.runner.settle(run.id);
	return notStarted;
}

/**
 * Runs of assistants that were disconnected (M21) or stopped by the kill switch (M29): pending
 * ones are cancelled; after the kill switch, running ones also lose their machines not started.
 * (A disconnected assistant's running run skips its remaining machines at their turn anyway.)
 */
export function settleEndedGrantRuns(context: PendingContext): number {
	let settled = 0;
	for (const run of openAssistantRuns(context.database)) {
		const grant =
			run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
		if (grant?.endedAt === null) {
			continue;
		}
		const by: CancelledBy = grant?.endedReason === 'kill-switch' ? 'kill-switch' : 'disconnect';
		if (run.status === 'pending-approval') {
			if (cancelPendingRun(context, run, by, run.startedBy)) {
				settled += 1;
			}
		} else if (run.status === 'running' && by === 'kill-switch') {
			cancelStartedRun(context, run, by, run.startedBy);
			settled += 1;
		}
	}
	return settled;
}

const EVERY_MS = 60_000;

/** Start-up: expire and settle now, then every minute (SPEC-MCP 10.1). */
export function schedulePendingSweeps(database: AppDatabase, runner: CommandRunner): void {
	const sweep = (): void => {
		const context = { database, runner, now: Date.now() };
		const expired = expirePendingRuns(context);
		const settled = settleEndedGrantRuns(context);
		if (expired + settled > 0) {
			serverLog(
				'info',
				'sessions',
				`AI assistant requests: ${String(expired)} expired, ${String(settled)} cancelled after a disconnect.`
			);
		}
	};
	sweep();
	setInterval(sweep, EVERY_MS).unref();
}
