import { z } from 'zod';
import { CONSOLE_ROLES } from '#lib/domain/users/user.ts';
import { emailSchema, passwordSchema, personNameSchema } from '../auth/sign-in.ts';

const roleSchema = z.enum(CONSOLE_ROLES);

/**
 * POST /api/users: add someone, with how they will sign in (SPEC-EMAIL E5):
 * a password set now, an invitation to choose one, or a provider only.
 */
export const createUserRequestSchema = z.object({
	name: personNameSchema,
	email: emailSchema,
	role: roleSchema,
	signIn: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('password'), value: passwordSchema }),
		z.object({ kind: z.literal('invite') }),
		z.object({ kind: z.literal('provider') })
	])
});

/** PATCH /api/users/<id>: one change at a time. */
export const updateUserRequestSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('set-details'), name: personNameSchema, email: emailSchema }),
	z.object({ action: z.literal('set-role'), role: roleSchema }),
	z.object({ action: z.literal('disable') }),
	z.object({ action: z.literal('enable') }),
	z.object({ action: z.literal('set-password'), password: passwordSchema })
]);

const userViewSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	email: z.string(),
	role: roleSchema,
	status: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('active') }),
		z.object({ kind: z.literal('disabled'), disabledIso: z.iso.datetime() })
	]),
	hasPassword: z.boolean(),
	providerNames: z.array(z.string()),
	lastSignIn: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('never') }),
		z.object({ kind: z.literal('at'), iso: z.iso.datetime() })
	]),
	createdIso: z.iso.datetime()
});

export const userReplySchema = z.object({ user: userViewSchema });

const invitationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('emailed'), to: z.string() }),
	z.object({ kind: z.literal('link'), url: z.url(), expiresIso: z.iso.datetime() })
]);

/** POST /api/users: the new user, and how they hear about it. */
export const createUserReplySchema = z.object({
	user: userViewSchema,
	invitation: invitationSchema
});

/** POST /api/users/<id>/invitation: a fresh invitation (earlier links stop working). */
export const invitationReplySchema = z.object({ invitation: invitationSchema });
