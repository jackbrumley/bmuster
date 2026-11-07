import { z } from 'zod';

/** SPEC-SIGN-IN S2: at least 12 characters. The upper bound keeps hashing cheap to refuse. */
export const MIN_PASSWORD_LENGTH = 12;

export const passwordSchema = z
	.string()
	.min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
	.max(256, 'Use at most 256 characters.');

export const emailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email('Enter an email address.').max(254));

export const personNameSchema = z.string().trim().min(1, 'Enter a name.').max(120);

/** The first admin, from /setup or the BMUSTER_ADMIN_* variables. */
export const firstAdminSchema = z.object({
	name: personNameSchema,
	email: emailSchema,
	password: passwordSchema
});

/** POST /setup: the first admin, with the setup code from the server's log (S17). */
export const setupRequestSchema = firstAdminSchema.extend({
	setupCode: z.string().trim().min(1, "Enter the setup code from the server's log.").max(64)
});

/** POST /login. Only presence is checked: the reply never says which part was wrong. */
export const signInRequestSchema = z.object({
	email: z.string().trim().toLowerCase().min(1).max(254),
	password: z.string().min(1).max(256)
});
