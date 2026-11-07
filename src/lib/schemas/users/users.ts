import { z } from 'zod';
import { CONSOLE_ROLES } from '#lib/domain/users/user.ts';
import { emailSchema, passwordSchema, personNameSchema } from '../auth/sign-in.ts';

const roleSchema = z.enum(CONSOLE_ROLES);

/** POST /api/users: add (invite) someone. */
export const createUserRequestSchema = z.object({
	name: personNameSchema,
	email: emailSchema,
	role: roleSchema,
	password: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({ kind: z.literal('set'), value: passwordSchema })
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
