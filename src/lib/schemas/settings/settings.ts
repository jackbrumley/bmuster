import { z } from 'zod';
import { SETTING_KEYS } from '#lib/domain/settings/settings-definitions.ts';

/** PATCH /api/settings: one setting; the value is checked against its declared type. */
export const updateSettingRequestSchema = z.object({
	key: z.enum(SETTING_KEYS),
	value: z.union([z.string(), z.boolean()])
});

const settingViewSchema = z.object({
	key: z.enum(SETTING_KEYS),
	value: z.union([z.string(), z.boolean()]),
	isDefault: z.boolean(),
	updated: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('never') }),
		z.object({ kind: z.literal('at'), iso: z.iso.datetime() })
	])
});

export const settingsReplySchema = z.object({ settings: z.array(settingViewSchema) });

/** POST /api/local-certificate (SPEC-INSTALL-OPTIONS L7). */
export const renewCertificateReplySchema = z.object({ renewed: z.literal(true) });
