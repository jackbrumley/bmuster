import { z } from 'zod';
import {
	EMAIL_SETTING_DEFINITIONS,
	SMTP_SECURITY
} from '#lib/domain/settings/email-settings-definitions.ts';
import { emailSchema } from '../auth/sign-in.ts';

/** An address, or nothing yet (allowed while email is off). */
const optionalEmail = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.refine((value) => value === '' || z.email().safeParse(value).success, 'Enter an email address.');

/** An http(s) address with no path, kept without a trailing slash; or nothing yet. */
const consoleUrlSchema = z
	.string()
	.trim()
	.max(300)
	.transform((value) => value.replace(/\/+$/, ''))
	.refine((value) => {
		if (value === '') {
			return true;
		}
		const parsed = URL.parse(value);
		return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
	}, 'Enter the address people open BMuster at, starting with https://.');

const hostSchema = z
	.string()
	.trim()
	.max(253)
	.regex(/^[A-Za-z0-9.:[\]-]*$/, 'Enter a host name, such as smtp.example.com.');

/** PUT /api/email/settings: every email setting at once (E1). The password is write-only. */
export const updateEmailSettingsRequestSchema = z
	.object({
		enabled: z.boolean(),
		fromName: z.string().trim().max(120),
		fromAddress: optionalEmail,
		consoleUrl: consoleUrlSchema,
		smtpHost: hostSchema,
		smtpPort: z.int('Enter a port number.').min(1, 'Enter a port number.').max(65535),
		smtpSecurity: z.enum(SMTP_SECURITY),
		smtpUsername: z.string().trim().max(254),
		smtpPassword: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('keep') }),
			z.object({ kind: z.literal('replace'), value: z.string().min(1).max(512) }),
			z.object({ kind: z.literal('clear') })
		])
	})
	.superRefine((settings, context) => {
		if (!settings.enabled) {
			return;
		}
		for (const key of ['fromAddress', 'consoleUrl', 'smtpHost'] as const) {
			if (settings[key] === '') {
				context.addIssue({
					code: 'custom',
					path: [key],
					message: `Enter the ${EMAIL_SETTING_DEFINITIONS[key].label.toLowerCase()} before turning email on.`
				});
			}
		}
	});

export type UpdateEmailSettingsRequest = z.infer<typeof updateEmailSettingsRequestSchema>;

const emailSettingsViewSchema = z.object({
	enabled: z.boolean(),
	fromName: z.string(),
	fromAddress: z.string(),
	consoleUrl: z.string(),
	smtpHost: z.string(),
	smtpPort: z.int(),
	smtpSecurity: z.enum(SMTP_SECURITY),
	smtpUsername: z.string(),
	password: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('set') }),
		z.object({ kind: z.literal('not-set') })
	])
});

export const emailSettingsReplySchema = z.object({ settings: emailSettingsViewSchema });

/** POST /api/email/test: send a test email now, to this address (E2). */
export const testEmailRequestSchema = z.object({ to: emailSchema });

export const testEmailReplySchema = z.object({
	result: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('sent'), reply: z.string() }),
		z.object({ kind: z.literal('failed'), error: z.string() })
	])
});
