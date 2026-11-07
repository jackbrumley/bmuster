import { z } from 'zod';
import { SCAM_QUESTION_IDS } from '#lib/domain/machines/phone-support.ts';

/** POST /api/support-codes (SPEC-JOIN J1): the machine groups Add machine has picked. */
export const createSupportCodeRequestSchema = z.object({
	machineGroupIds: z.array(z.uuid()).max(100)
});

export const createSupportCodeReplySchema = z.object({
	id: z.uuid(),
	/** Six digits. */
	code: z.string(),
	expiresAtIso: z.iso.datetime(),
	joinCodeId: z.uuid()
});

export const cancelSupportCodeReplySchema = z.object({ cancelled: z.literal(true) });

/** What a caller typed on /join; the server checks it is six digits. */
const typedCode = z.string().max(40);

/** POST /join/check: a code typed on /join, and what the page polls. */
export const joinCheckRequestSchema = z.object({ code: typedCode });

export const joinCheckReplySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('open'),
		supportPerson: z.string(),
		organisation: z.string(),
		expiresAtIso: z.iso.datetime(),
		/** The server's wording for the scam check (J11). */
		scamWording: z.object({ impersonators: z.string(), reportAdvice: z.string() })
	}),
	z.object({ kind: z.literal('connected'), supportPerson: z.string() })
]);

export type JoinCheckReply = z.infer<typeof joinCheckReplySchema>;

/** POST /join/stop: an unsafe answer in the scam check (J8). */
export const joinStopRequestSchema = z.object({
	code: typedCode,
	question: z.enum(SCAM_QUESTION_IDS)
});

export const joinStopReplySchema = z.object({ recorded: z.literal(true) });

/** POST /join/install: only three safe answers get the command (J7). */
export const joinInstallRequestSchema = z.object({
	code: typedCode,
	answers: z.object({
		contacted: z.literal('yes'),
		money: z.literal('no'),
		virus: z.literal('no')
	})
});

const installCommandSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('ready'), command: z.string() }),
	/** The server has no agent build for this OS. */
	z.object({ kind: z.literal('none') })
]);

export const joinInstallReplySchema = z.object({
	linux: installCommandSchema,
	windows: installCommandSchema
});

export type JoinInstallReply = z.infer<typeof joinInstallReplySchema>;
