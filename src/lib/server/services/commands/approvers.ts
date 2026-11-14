import {
	type ApprovalsNav,
	type ApprovalSummary,
	type LiveEvent
} from '#lib/domain/commands/assistant-runs.ts';
import { firstLine } from '#lib/domain/commands/commands.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineIdsWith, visibleMachineIds } from '../access/access.ts';
import type { LiveAudience } from '../live/live-events.ts';
import { findGrant } from '../oauth/grants.ts';
import {
	connectEligibility,
	inApproverGroup,
	mcpEnabled,
	readApproverSettings
} from '../oauth/mcp-settings.ts';
import { machinesOf, pendingRuns, scriptsOf, type RunRow } from './command-runs.ts';

/**
 * Who may decide an AI assistant's request (SPEC-MCP M19, M26): by the setting `mcp.approvers`,
 * the person it acts as, the approvers group, or both. Approving also needs `run-commands` on every
 * machine and a recent sign-in, checked when the person approves (assistant-runs.ts); this decides
 * who sees a request on the Approvals page and hears of it live.
 */

/** Whether the setting lets this person decide this run. */
export function approverByMode(
	database: Queryable,
	user: ConsoleUser,
	run: { startedBy: string }
): boolean {
	const approvers = readApproverSettings(database);
	const isRequester = user.id === run.startedBy;
	switch (approvers.mode) {
		case 'requester':
			return isRequester;
		case 'requester-or-group':
			return isRequester || inApproverGroup(database, approvers, user.id);
		case 'group-only':
			return inApproverGroup(database, approvers, user.id);
	}
}

/** Pending requests this person may decide and can see every machine of, newest first. */
export function pendingFor(database: Queryable, user: ConsoleUser): RunRow[] {
	const runs = pendingRuns(database).filter((run) => approverByMode(database, user, run));
	if (runs.length === 0) {
		return [];
	}
	const visible = visibleMachineIds(database, user);
	const machines = machinesOf(
		database,
		runs.map((run) => run.id)
	);
	return runs.filter((run) =>
		machines
			.filter((machine) => machine.runId === run.id)
			.every((machine) => visible.has(machine.machineId))
	);
}

/** One request as the Approvals page and the live notice show it. */
export function approvalSummaries(database: Queryable, runs: readonly RunRow[]): ApprovalSummary[] {
	const ids = runs.map((run) => run.id);
	const machines = machinesOf(database, ids);
	const scripts = scriptsOf(database, ids);
	return runs.map((run) => {
		const grant = run.oauthGrantId === null ? undefined : findGrant(database, run.oauthGrantId);
		return {
			runId: run.id,
			requestedBy: run.startedByName,
			assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
			machineNames: machines
				.filter((machine) => machine.runId === run.id)
				.map((machine) => machine.machineName),
			firstLine: firstLine(scripts.find((script) => script.runId === run.id)?.command ?? ''),
			requestedIso: run.startedAt.toISOString(),
			expiresIso: (run.expiresAt ?? run.startedAt).toISOString()
		};
	});
}

/**
 * The Approvals entry in the navigation (M26): shown to people who may run commands somewhere and
 * whom the setting lets approve (the people who may connect an assistant, the approvers group,
 * or both), with how many requests wait for them.
 */
export function approvalsNav(database: Queryable, user: ConsoleUser): ApprovalsNav {
	if (!mcpEnabled(database) || machineIdsWith(database, user, 'run-commands').size === 0) {
		return { kind: 'hidden' };
	}
	const approvers = readApproverSettings(database);
	const asRequester = connectEligibility(database, user.id).kind === 'eligible';
	const inGroup = inApproverGroup(database, approvers, user.id);
	const shown =
		approvers.mode === 'requester'
			? asRequester
			: approvers.mode === 'requester-or-group'
				? asRequester || inGroup
				: inGroup;
	return shown ? { kind: 'shown', pending: pendingFor(database, user).length } : { kind: 'hidden' };
}

/** What each open console hears of a new request: only people who may decide it (M26). */
export function requestedAudience(database: Queryable, runId: string): LiveAudience {
	return (user): LiveEvent | undefined => {
		const pending = pendingFor(database, user);
		const run = pending.find((candidate) => candidate.id === runId);
		if (run === undefined) {
			return undefined;
		}
		const [approval] = approvalSummaries(database, [run]);
		return approval === undefined
			? undefined
			: { kind: 'approval-requested', approval, pending: pending.length };
	};
}

/** What each open console hears when a request is decided, expires or is withdrawn. */
export function decidedAudience(database: Queryable, run: RunRow): LiveAudience {
	return (user): LiveEvent | undefined =>
		approverByMode(database, user, run)
			? { kind: 'approval-decided', runId: run.id, pending: pendingFor(database, user).length }
			: undefined;
}
