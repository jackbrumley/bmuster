/**
 * The email settings (SPEC-EMAIL E1), declared once, as the Wannon portal
 * declares its own: each one's stored key, label, description and default.
 * SMTP only. Browser-safe, so Settings → Email and the server read the same
 * list. The password is sealed with SECRETS_KEY and never leaves the server;
 * pages see only whether one is set.
 */

export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;

export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const SMTP_SECURITY_OPTIONS: readonly { value: SmtpSecurity; label: string }[] = [
	{ value: 'starttls', label: 'STARTTLS' },
	{ value: 'tls', label: 'Implicit TLS' },
	{ value: 'none', label: 'None' }
];

/** Every email setting except the password, as stored and as the page edits them. */
export type EmailSettingsFields = {
	enabled: boolean;
	fromName: string;
	fromAddress: string;
	/** The address people open BMuster at; links in emails start with it. */
	consoleUrl: string;
	smtpHost: string;
	smtpPort: number;
	smtpSecurity: SmtpSecurity;
	smtpUsername: string;
};

export type EmailSettingKey = keyof EmailSettingsFields | 'smtpPassword';

type EmailSettingDefinition = {
	/** The key in the settings table. */
	storedAs: `email.${EmailSettingKey}`;
	label: string;
	description: string;
};

export const EMAIL_SETTING_DEFINITIONS: Record<EmailSettingKey, EmailSettingDefinition> = {
	enabled: {
		storedAs: 'email.enabled',
		label: 'Send email',
		description:
			'Password resets, invitations and notifications. While it is off, nothing is sent and nothing waits to be sent.'
	},
	fromName: {
		storedAs: 'email.fromName',
		label: 'From name',
		description: 'The sender name people see, e.g. BMuster.'
	},
	fromAddress: {
		storedAs: 'email.fromAddress',
		label: 'From address',
		description: 'The address emails come from. Your mail server must allow it.'
	},
	consoleUrl: {
		storedAs: 'email.consoleUrl',
		label: 'Console address',
		description:
			'Where people open BMuster, e.g. https://bmuster.example.com. Links in emails start with it, never with what a browser claims.'
	},
	smtpHost: {
		storedAs: 'email.smtpHost',
		label: 'SMTP server',
		description: 'The host name of your mail server, e.g. smtp.example.com.'
	},
	smtpPort: {
		storedAs: 'email.smtpPort',
		label: 'Port',
		description: 'Usually 587 for STARTTLS and 465 for implicit TLS.'
	},
	smtpSecurity: {
		storedAs: 'email.smtpSecurity',
		label: 'Security',
		description:
			'STARTTLS refuses to send if the server will not upgrade. None sends in plain text, for a relay on the same machine only.'
	},
	smtpUsername: {
		storedAs: 'email.smtpUsername',
		label: 'Username',
		description: 'Leave empty if the server does not ask for one.'
	},
	smtpPassword: {
		storedAs: 'email.smtpPassword',
		label: 'Password',
		description: 'Stored encrypted. It is never shown again, only whether one is set.'
	}
};

export const EMAIL_SETTINGS_DEFAULTS: EmailSettingsFields = {
	enabled: false,
	fromName: 'BMuster',
	fromAddress: '',
	consoleUrl: '',
	smtpHost: '',
	smtpPort: 587,
	smtpSecurity: 'starttls',
	smtpUsername: ''
};

/** The email settings as Settings → Email shows them. */
export type EmailSettingsView = EmailSettingsFields & {
	password: { kind: 'set' } | { kind: 'not-set' };
};

/** What the console needs to know elsewhere: can it send email at all? */
export type EmailReadiness =
	{ kind: 'off' } | { kind: 'incomplete'; missing: string[] } | { kind: 'ready' };
