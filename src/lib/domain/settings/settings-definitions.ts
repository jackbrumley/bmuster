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
	| { kind: 'local-network-mode' }
	/** Plain text in a box with Save: one line, or several (`multiline`). */
	| { kind: 'text'; lines: 'single' | 'multiline'; maxLength: number };

/** Where the Settings page lists a setting. */
export type SettingSection = 'general' | 'security' | 'phone-support';

export const SETTING_SECTIONS: readonly { id: SettingSection; title: string }[] = [
	{ id: 'general', title: 'General' },
	{ id: 'security', title: 'Security' },
	{ id: 'phone-support', title: 'Phone support' }
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
const updatePolicySchema = z.enum(['automatic', 'manual']);

/** Plain text up to `max` characters, trimmed; `required` refuses a blank one. */
function textSchema(max: number, required: boolean): z.ZodType<string> {
	const trimmed = z
		.string()
		.trim()
		.max(max, `Keep it to ${String(max)} characters.`);
	return required ? trimmed.min(1, 'This cannot be blank.') : trimmed;
}

const ORGANISATION_NAME_MAX = 80;
const SCAM_TEXT_MAX = 400;

/** Largest upload in the Files tab, in GB (SPEC-FILES F6). */
const UPLOAD_LIMITS_GB = ['1', '5', '10', '50', '100', '1000'] as const;
const uploadLimitSchema = z.enum(UPLOAD_LIMITS_GB);

/** The largest upload the setting allows, in bytes. */
export function maxUploadBytes(gigabytes: z.infer<typeof uploadLimitSchema>): number {
	return Number(gigabytes) * 1024 ** 3;
}

export const SETTING_DEFINITIONS = {
	serverUpdateChecks: {
		label: 'Check for server updates daily',
		description:
			'Ask GitHub once a day for a newer signed server release. Check for updates still works when this is off.',
		schema: z.boolean(),
		defaultValue: true,
		changedBy: 'admin',
		section: 'general',
		control: { kind: 'switch' }
	} satisfies SettingDefinition<boolean>,
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
	agentUpdatePolicy: {
		label: 'Agent updates',
		description:
			'Automatic: a new agent version goes to the Early updates group first, then to 10% of machines after an hour without a failure, then to all. A failure pauses it. Manual: machines update only when an admin chooses Update now on the Updates page.',
		schema: updatePolicySchema,
		defaultValue: 'automatic',
		changedBy: 'admin',
		section: 'general',
		control: {
			kind: 'choice',
			options: [
				{ value: 'automatic', label: 'Automatic, in stages' },
				{ value: 'manual', label: 'Manual' }
			]
		}
	} satisfies SettingDefinition<z.infer<typeof updatePolicySchema>>,
	maxUploadGb: {
		label: 'Largest upload in Files',
		description:
			'The biggest single file anyone can send to a machine from its Files tab. Uploads go in 8 MB pieces and resume after a dropped connection.',
		schema: uploadLimitSchema,
		defaultValue: '10',
		changedBy: 'admin',
		section: 'general',
		control: {
			kind: 'choice',
			options: UPLOAD_LIMITS_GB.map((value) => ({
				value,
				label: value === '1000' ? '1 TB' : `${value} GB`
			}))
		}
	} satisfies SettingDefinition<z.infer<typeof uploadLimitSchema>>,
	localNetworkMode: {
		label: 'Local network mode',
		description:
			'For a server used only inside your own network, with no domain: BMuster serves HTTPS itself with a certificate it makes, and agents trust only that certificate. Takes effect when BMuster restarts.',
		schema: z.boolean(),
		defaultValue: false,
		changedBy: 'admin',
		section: 'security',
		control: { kind: 'local-network-mode' }
	} satisfies SettingDefinition<boolean>,
	organisationName: {
		label: 'Organisation name',
		description:
			'Who callers are told will get access on the phone support page: “<support person> at <organisation> will be able to see and control this computer”. Blank uses this server’s address.',
		schema: textSchema(ORGANISATION_NAME_MAX, false),
		defaultValue: '',
		changedBy: 'admin',
		section: 'phone-support',
		control: { kind: 'text', lines: 'single', maxLength: ORGANISATION_NAME_MAX }
	} satisfies SettingDefinition<string>,
	scamImpersonators: {
		label: 'Who scammers pretend to be',
		description:
			'In the warning on the phone support page: “Scammers pretend to be from <this>, and ask you to install remote access.”',
		schema: textSchema(SCAM_TEXT_MAX, true),
		defaultValue: 'Microsoft, your bank, the police, the NBN or a computer company',
		changedBy: 'admin',
		section: 'phone-support',
		control: { kind: 'text', lines: 'single', maxLength: SCAM_TEXT_MAX }
	} satisfies SettingDefinition<string>,
	scamReportAdvice: {
		label: 'Where to report a scam',
		description: 'Shown when a caller’s answers look like a scam. Web addresses become links.',
		schema: textSchema(SCAM_TEXT_MAX, true),
		defaultValue:
			'Report it to Scamwatch: https://www.scamwatch.gov.au/report-a-scam, or call ReportCyber on 1300 292 371.',
		changedBy: 'admin',
		section: 'phone-support',
		control: { kind: 'text', lines: 'multiline', maxLength: SCAM_TEXT_MAX }
	} satisfies SettingDefinition<string>
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
