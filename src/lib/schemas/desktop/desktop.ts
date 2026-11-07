/**
 * Messages from the agent's desktop session (SPEC-DESKTOP 5.2), parsed in
 * the browser. Display ids are strings (RandR monitor or Windows device
 * names). Types this console does not know yet fail to parse and are
 * ignored, so later phases can add messages.
 */
import { z } from 'zod';

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
	'bad-message'
] as const;

export const agentDesktopMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('displays'), list: z.array(displaySchema), current: z.string() }),
	z.object({
		type: z.literal('stream'),
		display: z.string(),
		codec: z.enum(['h264', 'jpeg', 'webp']),
		width: z.int(),
		height: z.int(),
		scale: z.number()
	}),
	z.object({
		type: z.literal('state'),
		desktop: z.enum(['default', 'winlogon', 'secure', 'greeter']),
		locked: z.boolean(),
		signedInUser: z.string().nullable()
	}),
	z.object({ type: z.literal('stalled') }),
	z.object({
		type: z.literal('error'),
		code: z.enum(DESKTOP_ERROR_CODES),
		message: z.string()
	})
]);

export type AgentDesktopMessage = z.infer<typeof agentDesktopMessageSchema>;
