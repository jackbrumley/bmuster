/**
 * Messages from the agent's desktop session (SPEC-DESKTOP 5.2), parsed in
 * the browser. Display ids are strings (RandR monitor or Windows device
 * names). Types this console does not know yet fail to parse and are
 * ignored, so later phases can add messages.
 */
import { z } from 'zod';
import { AUTO_LEVELS } from '#lib/domain/desktop/messages.ts';
import type { DesktopScreen } from '#lib/domain/desktop/screen.ts';

const displaySchema = z.object({
	id: z.string(),
	name: z.string(),
	x: z.int(),
	y: z.int(),
	width: z.int().min(1),
	height: z.int().min(1),
	scale: z.number(),
	primary: z.boolean()
});

export type DesktopDisplay = z.infer<typeof displaySchema>;

const DESKTOP_ERROR_CODES = [
	'not-allowed',
	'too-many-sessions',
	'capture-failed',
	'encoder-failed',
	'bad-message',
	'input-failed',
	'clipboard-failed'
] as const;

/** What the screen at the machine shows (`state`). */
const screenSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('sign-in') }),
	z.object({ kind: z.literal('locked'), user: z.string().nullable() }),
	z.object({ kind: z.literal('desktop'), user: z.string().nullable() }),
	z.object({ kind: z.literal('unavailable'), reason: z.string() }),
	z.object({
		kind: z.literal('approval'),
		phase: z.enum(['needed', 'pending', 'declined']),
		message: z.string()
	})
]) satisfies z.ZodType<DesktopScreen>;

/** The machine's clipboard text, and the confirmation of a push (SPEC-DESKTOP 21.3). */
const clipboardTextSchema = z.object({ type: z.literal('clipboard'), text: z.string() });
const clipboardSentSchema = z.object({ type: z.literal('clipboard-sent'), bytes: z.int().min(0) });

/** The agent's clipboard replies, which the relay audits (SPEC-DESKTOP 21.6). */
export const agentClipboardReplySchema = z.discriminatedUnion('type', [
	clipboardTextSchema,
	clipboardSentSchema
]);

/** The viewer's clipboard requests, which a watch-only session may not send (SPEC-DESKTOP 7). */
export const viewerClipboardRequestSchema = z.object({
	type: z.enum(['clipboard-push', 'clipboard-pull'])
});

export const agentDesktopMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('displays'),
		list: z.array(displaySchema),
		/** A display id, or `all` (SPEC-DESKTOP-ALL-SCREENS). */
		current: z.string(),
		/** The agent can show every display at once; older agents leave it out. */
		allScreens: z.boolean().default(false)
	}),
	z.object({
		type: z.literal('stream'),
		display: z.string(),
		codec: z.enum(['h264', 'jpeg', 'webp']),
		width: z.int(),
		height: z.int(),
		scale: z.number()
	}),
	z.object({ type: z.literal('state'), screen: screenSchema }),
	z.object({ type: z.literal('stalled') }),
	/** The level Auto picked (SPEC-DESKTOP 20); agents before it never send it. */
	z.object({ type: z.literal('auto-quality'), level: z.enum(AUTO_LEVELS) }),
	clipboardTextSchema,
	clipboardSentSchema,
	z.object({
		type: z.literal('error'),
		code: z.enum(DESKTOP_ERROR_CODES),
		message: z.string()
	})
]);
