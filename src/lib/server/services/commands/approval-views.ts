import type { ApprovalDecide, ApprovalView } from '#lib/domain/commands/assistant-runs.ts';
import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import { permissionsFor } from '../access/access.ts';
import { signInCheck } from '../auth/recent-sign-in.ts';
import { findGrant } from '../oauth/grants.ts';
import { approvalSummaries, pendingFor } from './approvers.ts';
import { expirePendingRuns } from './assistant-pending.ts';
import { machinePlans } from './assistant-runs.ts';
import { findRun, machinesOf, scriptsOf } from './command-runs.ts';
import type { CommandContext } from './commands.ts';

/**
 * What the Approvals page and the approval card show (SPEC-MCP M25, M26): pending requests the
 * person may decide, newest first, and for one request everything needed to read it, with whether
 * this person can approve it and how they prove it is them.
 */

type ViewContext = Pick<CommandContext, 'database' | 'runner' | 'user' | 'sessionToken' | 'now'>;

/** The Approvals page: expired requests are settled first, so none is offered after its time. */
export function listApprovals(context: ViewContext) {
	expirePendingRuns(context);
	return approvalSummaries(context.database, pendingFor(context.database, context.user));
}

/** One pending request as its approval card shows it; undefined when this person may not see it. */
export function approvalViewFor(context: ViewContext, runId: string): ApprovalView | undefined {
	expirePendingRuns(context);
	const run = pendingFor(context.database, context.user).find(
		(candidate) => candidate.id === runId
	);
	const [script] = scriptsOf(context.database, [runId]);
	if (run === undefined || script === undefined || findRun(context.database, runId) === undefined) {
		return undefined;
	}
	const machineIds = machinesOf(context.database, [runId]).map((machine) => machine.machineId);
	const plans = machinePlans(context.database, machineIds);
	const lacking = plans.filter(
		(plan) =>
			!permissionsFor(context.database, context.user, plan.id).some(
				(grant) => grant.permission === 'run-commands'
			)
	);
	const decide: ApprovalDecide =
		lacking.length > 0
			? {
					kind: 'no',
					why: `You cannot run commands on ${lacking.map((plan) => plan.name).join(', ')}, so someone else must approve it. You can still deny it.`
				}
			: {
					kind: 'yes',
					signIn: signInCheck(
						context.database,
						context.sessionToken,
						context.user.id,
						COMMAND_LIMITS.recentSignInMs,
						context.now
					)
				};
	const grant =
		run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
	return {
		runId,
		requestedBy: run.startedByName,
		assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
		verified: grant?.assistant.identity.kind === 'verified',
		reason: run.reason ?? '',
		requestedIso: run.startedAt.toISOString(),
		expiresIso: (run.expiresAt ?? run.startedAt).toISOString(),
		osFamily: script.osFamily,
		shell: script.shell,
		command: script.command,
		timeoutMs: run.timeoutMs,
		machines: plans,
		decide
	};
}
