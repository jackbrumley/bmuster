/**
 * Session requests and messages (SPEC-SESSIONS): the console's API, the
 * browser's session socket, and the agent's session socket. The agent's side
 * is agent/crates/protocol/src/session.rs; both must change together.
 */
import { z } from 'zod';
import {
	SESSION_END_REASONS,
	TERMINAL_SHELLS,
	type BrowserControl,
	type ServerControl
} from '#lib/domain/sessions/session.ts';

/** Terminal size limits; the agent clamps to the same. */
const cols = z.int().min(2).max(1000);
const rows = z.int().min(1).max(500);

/** `POST /api/machines/[id]/sessions` */
export const openSessionRequestSchema = z.object({
	kind: z.literal('terminal'),
	shell: z.enum(TERMINAL_SHELLS),
	cols,
	rows
});

export type OpenSessionRequest = z.infer<typeof openSessionRequestSchema>;

/** The session, and a ticket for the browser's socket (single use, 30 s). */
export const openSessionReplySchema = z.object({
	sessionId: z.uuid(),
	browserTicket: z.string().min(1)
});

export type OpenSessionReply = z.infer<typeof openSessionReplySchema>;

/**
 * `POST /api/sessions/[id]/browser-ticket`: a fresh ticket to reattach after
 * a reload, or how the session ended.
 */
export const browserTicketReplySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('issued'), browserTicket: z.string().min(1) }),
	z.object({ kind: z.literal('ended'), message: z.string() })
]);

export type BrowserTicketReply = z.infer<typeof browserTicketReplySchema>;

/** Text frames from the browser. */
export const browserControlSchema: z.ZodType<BrowserControl> = z.discriminatedUnion('type', [
	z.object({ type: z.literal('resize'), cols, rows }),
	z.object({ type: z.literal('end') })
]);

/** Text frames to the browser (parsed by the terminal page). */
export const serverControlSchema: z.ZodType<ServerControl> = z.discriminatedUnion('type', [
	z.object({ type: z.literal('attached'), resumed: z.boolean() }),
	z.object({ type: z.literal('ready') }),
	z.object({
		type: z.literal('ended'),
		reason: z.enum(SESSION_END_REASONS),
		message: z.string()
	})
]);

/** Text frames from the agent on a session socket: its last word. */
export const agentSessionEventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('exited'), code: z.int() }),
	z.object({ type: z.literal('failed'), message: z.string().max(2000) }),
	z.object({
		type: z.literal('exec-done'),
		exitCode: z.int(),
		durationMs: z.int().min(0),
		truncated: z.boolean(),
		timedOut: z.boolean()
	})
]);
