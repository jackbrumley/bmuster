/**
 * Approving an AI assistant's command in the console (SPEC-MCP 13.3), and the console's live
 * channel. The approval card and the server check the edited command with the same schema.
 */
import { z } from 'zod';
import { recheckSchema } from '../auth/recheck.ts';
import {
	ASSISTANT_RUN_LIMITS,
	type ApprovalSummary,
	type LiveEvent
} from '#lib/domain/commands/assistant-runs.ts';
import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';

/** The event name on GET /api/live. */
export const LIVE_EVENT = 'live';

/**
 * POST /api/commands/runs/<id>/approve: the command and time limit as approved (the same as asked
 * for, or edited), the typed count, and the password or code when the sign-in is not recent (M19, M20).
 * Machines and shell cannot be changed.
 */
export const approveRequestSchema = z.object({
	command: z.string(),
	timeoutMs: z
		.int()
		.min(COMMAND_LIMITS.minTimeoutMs, 'The time limit is at least 5 seconds.')
		.max(COMMAND_LIMITS.maxTimeoutMs, 'The time limit is at most 10 minutes.'),
	confirmCount: z.int().min(0),
	recheck: recheckSchema
});

export type ApproveRequest = z.infer<typeof approveRequestSchema>;

/** POST /api/commands/runs/<id>/deny: a note the assistant reads (M20). */
export const denyRequestSchema = z.object({
	note: z
		.string()
		.max(
			ASSISTANT_RUN_LIMITS.maxDenyNoteChars,
			`A note is at most ${String(ASSISTANT_RUN_LIMITS.maxDenyNoteChars)} characters.`
		)
});

export const decidedReplySchema = z.object({ runId: z.uuid() });

const approvalSummarySchema: z.ZodType<ApprovalSummary> = z.object({
	runId: z.uuid(),
	requestedBy: z.string(),
	assistant: z.string(),
	machineNames: z.array(z.string()),
	firstLine: z.string(),
	requestedIso: z.iso.datetime(),
	expiresIso: z.iso.datetime()
});

export const liveEventSchema: z.ZodType<LiveEvent> = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('approval-requested'),
		approval: approvalSummarySchema,
		pending: z.int()
	}),
	z.object({ kind: z.literal('approval-decided'), runId: z.uuid(), pending: z.int() })
]);
