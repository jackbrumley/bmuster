import { z } from 'zod';
import {
	CHECK_STATUSES,
	MAX_CHECK_DETAIL,
	MAX_CHECKS,
	type MachineChecks,
	type MachineSessionView
} from '#lib/domain/logs/checks.ts';
import { MAX_READ_LIMIT } from '#lib/domain/logs/logs.ts';

/**
 * Self-checks and session timelines (SPEC-DIAGNOSTICS): what the agent sends, what the
 * diagnostics endpoints reply, and the JSON inside timeline and figures records. The Rust side is
 * agent/crates/protocol/src/checks.rs.
 */

const word = z.string().max(255);
const count = z.number().int().min(0);

/** One result as the agent sends it; `checkedAt` is Unix milliseconds. */
export const checkResultSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]{1,64}$/),
	title: word,
	status: z.enum(CHECK_STATUSES),
	detail: z.string().max(MAX_CHECK_DETAIL),
	durationMs: count,
	checkedAt: count
});

export type CheckResultWire = z.infer<typeof checkResultSchema>;

/** The check-in's `checks`; `unreported` is what an agent before 0.4.3 means by leaving it out. */
export const checksReportSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unreported') }),
	z.object({ kind: z.literal('pending') }),
	z.object({ kind: z.literal('results'), results: z.array(checkResultSchema).max(MAX_CHECKS) })
]);

export type ChecksReport = z.infer<typeof checksReportSchema>;

/** What `machine_checks.results` holds. */
export const storedChecksSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('pending') }),
	z.object({ kind: z.literal('results'), results: z.array(checkResultSchema) })
]);

/** The text of a `session-timeline` record. */
export const timelineTextSchema = z.object({
	sessionId: z.string().min(1).max(64),
	kind: word,
	startedAt: count,
	outcome: z.enum(['ended', 'failed']),
	reason: z.string().max(2048),
	steps: z.array(z.object({ t: count, step: word, detail: z.string().max(2048) })).max(200),
	omitted: count
});

/** The text of a `session-stats` record. */
export const statsTextSchema = z.object({
	sessionId: z.string().min(1).max(64),
	intervalMs: count,
	framesSent: count,
	captureMsAvg: z.number().min(0),
	encodeMsAvg: z.number().min(0),
	bytesPerSecond: count,
	droppedFrames: count,
	tiles: count,
	backend: word
});

const resultView = z.object({
	id: z.string(),
	title: z.string(),
	status: z.enum(CHECK_STATUSES),
	detail: z.string(),
	durationMs: z.number(),
	checkedAtIso: z.string()
});

/** GET /api/diagnostics/machines/<id>/checks */
export const machineChecksSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unreported') }),
	z.object({ kind: z.literal('pending'), receivedIso: z.string() }),
	z.object({ kind: z.literal('results'), receivedIso: z.string(), results: z.array(resultView) })
]) satisfies z.ZodType<MachineChecks>;

/** POST /api/machines/<id>/checks */
export const runChecksReplySchema = z.object({ requested: z.literal(true) });

const statsView = z.object({
	atIso: z.string(),
	intervalMs: z.number(),
	framesSent: z.number(),
	captureMsAvg: z.number(),
	encodeMsAvg: z.number(),
	bytesPerSecond: z.number(),
	droppedFrames: z.number(),
	tiles: z.number(),
	backend: z.string()
});

const sessionView = z.object({
	sessionId: z.string(),
	kind: z.string(),
	startedIso: z.string(),
	server: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('unknown') }),
		z.object({
			kind: z.literal('known'),
			userName: z.string(),
			openedIso: z.string(),
			ended: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('running') }),
				z.object({ kind: z.literal('ended'), endedIso: z.string(), how: z.string() })
			])
		})
	]),
	timeline: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({
			kind: z.literal('shipped'),
			outcome: z.enum(['ended', 'failed']),
			reason: z.string(),
			startedIso: z.string(),
			steps: z.array(z.object({ t: z.number(), step: z.string(), detail: z.string() })),
			omitted: z.number()
		})
	]),
	stats: z.array(statsView)
}) satisfies z.ZodType<MachineSessionView>;

/** GET /api/diagnostics/machines/<id>/sessions */
export const machineSessionsSchema = z.object({ sessions: z.array(sessionView) });

const DEFAULT_SESSIONS = 20;
const MAX_SESSIONS = 200;

/** Query parameters of the sessions read: `since` (ISO) and `limit` (capped at 200). */
export const sessionsQuerySchema = z.object({
	since: z.iso.datetime().nullable(),
	limit: z
		.string()
		.regex(/^\d{1,6}$/, 'limit is a whole number.')
		.nullable()
		.transform((text) =>
			text === null
				? DEFAULT_SESSIONS
				: Math.min(Math.max(Number(text), 1), Math.min(MAX_SESSIONS, MAX_READ_LIMIT))
		)
});
