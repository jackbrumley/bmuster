import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import type {
	CleanupApprovalView,
	CleanupDecide,
	CleanupRequestState
} from '#lib/domain/storage/cleanup-requests.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import { signInCheck } from '../auth/recent-sign-in.ts';
import { cleanupSummaries, pendingCleanupsFor } from '../commands/approvers.ts';
import type { CleanupRequestRow } from '../machines/cleanup-requests.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import { findGrant } from '../oauth/grants.ts';
import {
	decidable,
	expireCleanupRequests,
	expireRequest,
	holds,
	type CleanupDeciderContext
} from './cleanup-requests.ts';

/**
 * What the Approvals page and a clean-up's approval card show (SPEC-MCP M54): the requests this
 * person may decide, and for one request the machine, who asked, the reason, each item with its
 * size when asked, and whether this person can approve it and how they prove it is them.
 */

/** The Approvals page's clean-ups (M54): expired ones are settled first. */
export function listCleanupApprovals(database: AppDatabase, user: ConsoleUser, now: number) {
	expireCleanupRequests(database, now);
	return cleanupSummaries(database, pendingCleanupsFor(database, user));
}

function stateOf(context: CleanupDeciderContext, request: CleanupRequestRow): CleanupRequestState {
	switch (request.status) {
		case 'pending': {
			const decide: CleanupDecide = holds(
				context.database,
				context.user,
				request.machineId,
				'files'
			)
				? {
						kind: 'yes',
						signIn: signInCheck(
							context.database,
							context.sessionToken,
							context.user.id,
							COMMAND_LIMITS.recentSignInMs,
							context.now
						)
					}
				: {
						kind: 'no',
						why: `You cannot use files on ${request.machineName}, so someone else must approve it. You can still deny it.`
					};
			return { kind: 'pending', decide };
		}
		case 'approved':
			return { kind: 'approved', by: request.decidedByName ?? 'someone' };
		case 'denied':
			return {
				kind: 'denied',
				by: request.decidedByName ?? 'someone',
				note: request.denyNote ?? ''
			};
		case 'expired':
			return { kind: 'expired' };
		case 'cancelled':
			return { kind: 'cancelled' };
	}
}

/** One request as its approval card shows it; undefined when this person may not see it (M54). */
export function cleanupApprovalView(
	context: CleanupDeciderContext,
	requestId: string
): CleanupApprovalView | undefined {
	expireRequest(context.database, requestId, context.now);
	const request = decidable(context, requestId);
	const basics =
		request === undefined ? undefined : activeMachineBasics(context.database, request.machineId);
	if (request === undefined || basics === undefined) {
		return undefined;
	}
	const grant = findGrant(context.database, request.oauthGrantId);
	return {
		requestId: request.id,
		machine: {
			id: request.machineId,
			name: request.machineName,
			osFamily: basics.osFamily,
			online: isAgentConnected(request.machineId)
		},
		requestedBy: request.userName,
		assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
		verified: grant?.assistant.identity.kind === 'verified',
		reason: request.reason,
		requestedIso: request.requestedAt.toISOString(),
		expiresIso: request.expiresAt.toISOString(),
		items: request.sizes,
		state: stateOf(context, request)
	};
}
