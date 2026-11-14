import { z } from 'zod';
import type { TwoFactorKey } from '#lib/domain/auth/two-factor.ts';

/** Requests and replies for two-factor sign-in (SPEC-TWO-FACTOR 6). */

/** A code from the authenticator app: six digits, spaces allowed. */
export const authenticatorCodeSchema = z
	.string()
	.transform((typed) => typed.replace(/\s/g, ''))
	.pipe(z.string().regex(/^\d{6}$/, 'Type the 6-digit code from your authenticator app.'));

/** A code from the app or a recovery code: the server tells which by its shape. */
export const secondStepCodeSchema = z
	.string()
	.trim()
	.min(1, 'Type the code from your authenticator app, or a recovery code.')
	.max(64, 'That is longer than any code.');

const passwordGiven = z.string().min(1, 'Type your password.').max(256);

/** POST /login/two-factor (a form action). */
export const codeStepRequestSchema = z.object({ code: secondStepCodeSchema });

/** POST /login/two-factor/set-up (a form action): the first code from the app. */
export const setUpStepRequestSchema = z.object({ code: authenticatorCodeSchema });

/** POST /api/account/two-factor: turn it on. */
export const turnOnRequestSchema = z.object({
	code: authenticatorCodeSchema,
	password: passwordGiven
});

/** DELETE /api/account/two-factor: turn it off. */
export const turnOffRequestSchema = z.object({
	password: passwordGiven,
	code: secondStepCodeSchema
});

/** POST /api/account/two-factor/recovery-codes: a new set. */
export const newRecoveryCodesRequestSchema = z.object({ code: authenticatorCodeSchema });

const twoFactorKeySchema: z.ZodType<TwoFactorKey> = z.object({
	otpauthUri: z.string().startsWith('otpauth://totp/'),
	keyText: z.string(),
	qr: z.object({ size: z.int().positive(), path: z.string() })
});

export const setUpReplySchema = z.object({ key: twoFactorKeySchema });

export const recoveryCodesReplySchema = z.object({ recoveryCodes: z.array(z.string()) });

export const turnedOffReplySchema = z.object({ turnedOff: z.literal(true) });

export const resetReplySchema = z.object({ reset: z.literal(true) });
