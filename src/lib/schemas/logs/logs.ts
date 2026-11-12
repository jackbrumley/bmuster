import { z } from 'zod';
import { DIAGNOSTICS_TOKEN_DAYS } from '#lib/domain/logs/diagnostics-tokens.ts';
import {
	LOG_LEVELS,
	LOG_ORDERS,
	LOG_SOURCES,
	MAX_READ_LIMIT,
	type AgentLogRecordView,
	type LogPage,
	type ServerLogRecordView
} from '#lib/domain/logs/logs.ts';

/** Request and reply contracts for logs, verbose mode and diagnostics tokens (SPEC-AGENT-LOGS). */

const CURSOR = /^([oa]-\d{1,15}-\d{1,15}|n-\d{1,15})$/;
const DEFAULT_LIMIT = 200;

/**
 * Query parameters shared by both log reads. Limits above 2000 are capped. `order` is `newest`
 * unless given; a cursor carries its own direction.
 */
const windowFields = {
	since: z.iso.datetime().nullable(),
	order: z
		.enum(LOG_ORDERS)
		.nullable()
		.transform((order) => order ?? 'newest'),
	until: z.iso.datetime().nullable(),
	level: z.enum(LOG_LEVELS).nullable(),
	cursor: z.string().regex(CURSOR, 'That cursor is not one this server gave out.').nullable(),
	limit: z
		.string()
		.regex(/^\d{1,6}$/, 'limit is a whole number.')
		.nullable()
		.transform((text) =>
			text === null ? DEFAULT_LIMIT : Math.min(Math.max(Number(text), 1), MAX_READ_LIMIT)
		)
};

export const agentLogQuerySchema = z.object({
	...windowFields,
	source: z.enum(LOG_SOURCES).nullable()
});

export const serverLogQuerySchema = z.object({
	...windowFields,
	area: z
		.string()
		.regex(/^[a-z-]{1,32}$/, 'area is a word such as sessions or agents.')
		.nullable()
});

const level = z.enum(LOG_LEVELS);

const continuation = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('cursor'), cursor: z.string() })
]);

const pageFields = {
	older: continuation,
	later: continuation,
	newer: z.string()
};

export const agentLogPageSchema = z.object({
	records: z.array(
		z.object({
			instance: z.string(),
			seq: z.number(),
			atIso: z.string(),
			level,
			source: z.enum(LOG_SOURCES),
			target: z.string(),
			text: z.string()
		})
	),
	...pageFields
}) satisfies z.ZodType<LogPage<AgentLogRecordView>>;

export const serverLogPageSchema = z.object({
	records: z.array(
		z.object({
			instance: z.string(),
			seq: z.number(),
			atIso: z.string(),
			level,
			area: z.string(),
			machineId: z.string().nullable(),
			text: z.string()
		})
	),
	...pageFields
}) satisfies z.ZodType<LogPage<ServerLogRecordView>>;

/** POST /api/machines/<id>/verbose */
export const verboseRequestSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('hour') }),
	z.object({ kind: z.literal('stop') })
]);

export const verboseReplySchema = z.object({
	untilIso: z.string().nullable(),
	delivered: z.boolean()
});

/** POST /api/diagnostics-tokens */
export const createTokenRequestSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, 'Give the token a name, such as the tool that will use it.')
		.max(100, 'Keep the name under 100 characters.'),
	days: z.union(DIAGNOSTICS_TOKEN_DAYS.map((days) => z.literal(days)))
});

export const createdTokenReplySchema = z.object({
	id: z.string(),
	token: z.string(),
	expiresIso: z.string()
});

export const revokedTokenReplySchema = z.object({ revoked: z.literal(true) });
