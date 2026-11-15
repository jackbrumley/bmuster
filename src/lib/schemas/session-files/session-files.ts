/**
 * Files sent through a desktop session (SPEC-SESSION-FILES): the console's
 * requests and replies, and the agent's replies on a session-files socket
 * (agent/crates/protocol/src/user_files.rs; both change together).
 */
import { z } from 'zod';
import {
	SESSION_FILE_ERROR_CODES,
	type SendTarget,
	type TransferRow
} from '#lib/domain/session-files/session-files.ts';

const bytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.uuid();

/**
 * One file's name: one part, no control characters, colons or slashes, at most 255 bytes. The
 * helper on the machine applies the full rules (Windows names, trailing dots) on every system.
 */
export const sentNameSchema = z
	.string()
	.min(1, 'A file needs a name.')
	.refine((name) => new TextEncoder().encode(name).byteLength <= 255, 'That name is too long.')
	.refine((name) => name !== '.' && name !== '..', 'That is not a file name.')
	.refine(
		(name) => ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
		'A file name cannot hold control characters.'
	)
	.refine((name) => !/[/\\:]/.test(name), 'A file name cannot hold / \\ or :.');

/** `GET …/session-files/target?desktopSessionId=` */
export const targetQuerySchema = z.object({ desktopSessionId: id });

export const sendTargetSchema: z.ZodType<SendTarget> = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('ready'),
		user: z.string(),
		folderLabel: z.string(),
		free: bytes
	}),
	z.object({ kind: z.literal('refused'), message: z.string() })
]);

/** `POST …/session-files/send/begin`: a new file, or one this person started before. */
export const sendBeginRequestSchema = z.object({
	desktopSessionId: id,
	batchId: id,
	transferId: id.nullable(),
	name: sentNameSchema,
	size: bytes
});

export const sendBeginReplySchema = z.object({ transferId: id, partSize: bytes });

/** `PUT …/session-files/send?transferId=&offset=` */
export const sendChunkQuerySchema = z.object({
	transferId: id,
	offset: z.coerce.number().pipe(bytes)
});

export const partReplySchema = z.object({ partSize: bytes });

/** `POST …/session-files/send/end` */
export const sendEndRequestSchema = z.object({
	transferId: id,
	sha256: z.string().regex(/^[0-9a-f]{64}$/)
});

export const sendEndReplySchema = z.object({ savedAs: z.string() });

/** `POST …/session-files/send/cancel` and `…/transfers/<id>/cancel` */
export const sendCancelRequestSchema = z.object({ transferId: id });

export const emptyReplySchema = z.object({});

/** `POST …/session-files/send/finish` */
export const sendFinishRequestSchema = z.object({ batchId: id });

export const sendFinishReplySchema = z.object({ onClipboard: z.boolean() });

const transferRowSchema: z.ZodType<TransferRow> = z.object({
	id,
	direction: z.enum(['to-machine', 'from-machine']),
	name: z.string(),
	size: bytes,
	bytes,
	startedIso: z.string(),
	state: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('running') }),
		z.object({ kind: z.literal('done'), savedAs: z.string() }),
		z.object({ kind: z.literal('failed'), message: z.string() }),
		z.object({ kind: z.literal('cancelled') })
	])
});

/** `GET …/session-files/transfers` */
export const transfersReplySchema = z.object({ transfers: z.array(transferRowSchema) });

/** The agent's reply to one request. */
export const agentSessionFilesReplySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('done'), id: z.int().min(0), result: z.unknown() }),
	z.object({
		type: z.literal('error'),
		id: z.int().min(0),
		code: z.enum(SESSION_FILE_ERROR_CODES),
		message: z.string().max(4000)
	})
]);

export const agentTargetSchema = z.object({
	user: z.string().max(256),
	folderLabel: z.string().max(4096),
	free: bytes
});

export const agentSavedSchema = z.object({
	savedAs: z.string().max(255 * 4),
	size: bytes,
	sha256: z.string().regex(/^[0-9a-f]{64}$/)
});
