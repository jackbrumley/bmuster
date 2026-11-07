import { z } from 'zod';
import { CONSENTS } from '../access/access.ts';

/**
 * Every server setting, declared once (SPEC-SIGN-IN S16): its key, type,
 * default, who may change it and how the Settings page shows it. Browser-safe,
 * so the page and the server read the same list. A new setting is one more
 * entry here; the compiler then lists every place that must handle it.
 */

type SettingControl =
	| { kind: 'switch' }
	| { kind: 'choice'; options: readonly { value: string; label: string }[] }
	/** On and off, with the confirmation and certificate details of SPEC-INSTALL-OPTIONS L2. */
	| { kind: 'local-network-mode' };

/** Where the Settings page lists a setting. */
export type SettingSection = 'general' | 'security';

export const SETTING_SECTIONS: readonly { id: SettingSection; title: string }[] = [
	{ id: 'general', title: 'General' },
	{ id: 'security', title: 'Security' }
];

type SettingDefinition<T> = {
	label: string;
	description: string;
	schema: z.ZodType<T>;
	defaultValue: T;
	/** Who may change it. Only admins so far. */
	changedBy: 'admin';
	section: SettingSection;
	control: SettingControl;
};

const consentSchema = z.enum(CONSENTS);

export const SETTING_DEFINITIONS = {
	defaultConsent: {
		label: 'Default for new access rules',
		description:
			'Whether a new access rule connects straight away or asks the person at the screen first.',
		schema: consentSchema,
		defaultValue: 'unattended',
		changedBy: 'admin',
		section: 'general',
		control: {
			kind: 'choice',
			options: [
				{ value: 'unattended', label: 'Connect straight away' },
				{ value: 'ask', label: 'Ask the person at the screen' }
			]
		}
	} satisfies SettingDefinition<z.infer<typeof consentSchema>>,
	connectedNotice: {
		label: 'Show a notice while connected',
		description:
			'The person at the screen sees “<name> is connected (BMuster)” while a desktop or terminal session is open.',
		schema: z.boolean(),
		defaultValue: true,
		changedBy: 'admin',
		section: 'general',
		control: { kind: 'switch' }
	} satisfies SettingDefinition<boolean>,
	localNetworkMode: {
		label: 'Local network mode',
		description:
			'For a server used only inside your own network, with no domain: BMuster serves HTTPS itself with a certificate it makes, and agents trust only that certificate. Takes effect when BMuster restarts.',
		schema: z.boolean(),
		defaultValue: false,
		changedBy: 'admin',
		section: 'security',
		control: { kind: 'local-network-mode' }
	} satisfies SettingDefinition<boolean>
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export type SettingValues = {
	[K in SettingKey]: z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;
};

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS).filter(
	(key): key is SettingKey => key in SETTING_DEFINITIONS
);

/** One setting as the Settings page shows it. */
export type SettingView = {
	key: SettingKey;
	value: string | boolean;
	isDefault: boolean;
	updated: { kind: 'never' } | { kind: 'at'; iso: string };
};
