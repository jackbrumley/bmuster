import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
	EMAIL_SETTING_DEFINITIONS,
	EMAIL_SETTINGS_DEFAULTS,
	SMTP_SECURITY,
	type EmailReadiness,
	type EmailSettingKey,
	type EmailSettingsFields,
	type EmailSettingsView,
	type SmtpSecurity
} from '#lib/domain/settings/email-settings-definitions.ts';
import type { UpdateEmailSettingsRequest } from '#lib/schemas/email/email.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { settings } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * The email settings (SPEC-EMAIL E1), kept in the settings table under
 * `email.*` keys. The SMTP password is sealed with SECRETS_KEY (AES-256-GCM)
 * and write-only: views say only whether one is set, and only the sender
 * opens it. Every change is audited, the password as "replaced" or "cleared".
 */

const FIELD_KEYS = [
	'enabled',
	'fromName',
	'fromAddress',
	'consoleUrl',
	'smtpHost',
	'smtpPort',
	'smtpSecurity',
	'smtpUsername'
] as const satisfies readonly (keyof EmailSettingsFields)[];

const FIELD_SCHEMAS: { [K in keyof EmailSettingsFields]: z.ZodType<EmailSettingsFields[K]> } = {
	enabled: z.boolean(),
	fromName: z.string(),
	fromAddress: z.string(),
	consoleUrl: z.string(),
	smtpHost: z.string(),
	smtpPort: z.int(),
	smtpSecurity: z.enum(SMTP_SECURITY),
	smtpUsername: z.string()
};

const ALL_STORED = Object.values(EMAIL_SETTING_DEFINITIONS).map(
	(definition) => definition.storedAs
);

function storedRows(database: Queryable): Map<string, string> {
	return new Map(
		database
			.select({ key: settings.key, value: settings.value })
			.from(settings)
			.where(inArray(settings.key, ALL_STORED))
			.all()
			.map((row) => [row.key, row.value])
	);
}

function field<K extends keyof EmailSettingsFields>(
	rows: Map<string, string>,
	key: K
): EmailSettingsFields[K] {
	const stored = rows.get(EMAIL_SETTING_DEFINITIONS[key].storedAs);
	return stored === undefined
		? EMAIL_SETTINGS_DEFAULTS[key]
		: FIELD_SCHEMAS[key].parse(JSON.parse(stored));
}

function fields(rows: Map<string, string>): EmailSettingsFields {
	return {
		enabled: field(rows, 'enabled'),
		fromName: field(rows, 'fromName'),
		fromAddress: field(rows, 'fromAddress'),
		consoleUrl: field(rows, 'consoleUrl'),
		smtpHost: field(rows, 'smtpHost'),
		smtpPort: field(rows, 'smtpPort'),
		smtpSecurity: field(rows, 'smtpSecurity'),
		smtpUsername: field(rows, 'smtpUsername')
	};
}

function sealedPassword(rows: Map<string, string>): string | undefined {
	const stored = rows.get(EMAIL_SETTING_DEFINITIONS.smtpPassword.storedAs);
	return stored === undefined ? undefined : z.string().parse(JSON.parse(stored));
}

export function readEmailSettings(database: Queryable): EmailSettingsView {
	const rows = storedRows(database);
	return {
		...fields(rows),
		password: sealedPassword(rows) === undefined ? { kind: 'not-set' } : { kind: 'set' }
	};
}

/** Whether email can be sent, and if not, why (shown to admins). */
export function emailReadiness(database: Queryable): EmailReadiness {
	const current = fields(storedRows(database));
	if (!current.enabled) {
		return { kind: 'off' };
	}
	const missing = (['fromAddress', 'consoleUrl', 'smtpHost'] as const)
		.filter((key) => current[key] === '')
		.map((key) => EMAIL_SETTING_DEFINITIONS[key].label);
	return missing.length === 0 ? { kind: 'ready' } : { kind: 'incomplete', missing };
}

/** Everything the sender needs, with the password opened. Only for sending. */
export type SmtpSettings = {
	fromName: string;
	fromAddress: string;
	host: string;
	port: number;
	security: SmtpSecurity;
	auth: { kind: 'none' } | { kind: 'password'; username: string; password: string };
};

export type EmailSetup =
	{ kind: 'not-ready'; reason: string } | { kind: 'ready'; smtp: SmtpSettings; consoleUrl: string };

/**
 * The SMTP settings for sending: `queue` needs email on and fully set up;
 * `test` (the test email, E2) only needs a server and a from address, so an
 * admin can try the settings before turning email on.
 */
export function emailSetup(
	database: Queryable,
	secretsKey: Buffer,
	purpose: 'queue' | 'test'
): EmailSetup {
	const readiness = emailReadiness(database);
	if (purpose === 'queue') {
		switch (readiness.kind) {
			case 'off':
				return { kind: 'not-ready', reason: 'Email is turned off in Settings → Email.' };
			case 'incomplete':
				return {
					kind: 'not-ready',
					reason: `Email is not set up yet: ${readiness.missing.join(', ')} missing.`
				};
			case 'ready':
				break;
		}
	}
	const rows = storedRows(database);
	const current = fields(rows);
	const missing = (['smtpHost', 'fromAddress'] as const).filter((key) => current[key] === '');
	if (missing.length > 0) {
		return {
			kind: 'not-ready',
			reason: `Save the ${missing.map((key) => EMAIL_SETTING_DEFINITIONS[key].label.toLowerCase()).join(' and ')} first.`
		};
	}
	const sealed = sealedPassword(rows);
	return {
		kind: 'ready',
		consoleUrl: current.consoleUrl,
		smtp: {
			fromName: current.fromName,
			fromAddress: current.fromAddress,
			host: current.smtpHost,
			port: current.smtpPort,
			security: current.smtpSecurity,
			auth:
				current.smtpUsername === ''
					? { kind: 'none' }
					: {
							kind: 'password',
							username: current.smtpUsername,
							password: sealed === undefined ? '' : openSecret(sealed, secretsKey).toString('utf8')
						}
		}
	};
}

function writeRow(
	database: Queryable,
	key: EmailSettingKey,
	value: unknown,
	actorUserId: string,
	now: number
): void {
	const row = {
		key: EMAIL_SETTING_DEFINITIONS[key].storedAs,
		value: JSON.stringify(value),
		updatedAt: new Date(now),
		updatedBy: actorUserId
	};
	database
		.insert(settings)
		.values(row)
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
		})
		.run();
}

function auditChange(
	database: Queryable,
	actorUserId: string,
	key: EmailSettingKey,
	detail: Record<string, string>,
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: 'setting-changed',
			target: `Email: ${EMAIL_SETTING_DEFINITIONS[key].label}`,
			machineId: null,
			detail
		},
		now
	);
}

/** Saves the email settings an admin sent; one audit entry per changed setting. */
export function updateEmailSettings(
	database: AppDatabase,
	actorUserId: string,
	input: UpdateEmailSettingsRequest,
	secretsKey: Buffer,
	now: number
): EmailSettingsView {
	return database.transaction((transaction) => {
		const rows = storedRows(transaction);
		const before = fields(rows);
		for (const key of FIELD_KEYS) {
			if (before[key] !== input[key]) {
				writeRow(transaction, key, input[key], actorUserId, now);
				auditChange(
					transaction,
					actorUserId,
					key,
					{ from: String(before[key]), to: String(input[key]) },
					now
				);
			}
		}
		const password = input.smtpPassword;
		const hadPassword = sealedPassword(rows) !== undefined;
		switch (password.kind) {
			case 'keep':
				break;
			case 'replace':
				writeRow(
					transaction,
					'smtpPassword',
					sealSecret(Buffer.from(password.value, 'utf8'), secretsKey),
					actorUserId,
					now
				);
				auditChange(transaction, actorUserId, 'smtpPassword', { password: 'replaced' }, now);
				break;
			case 'clear':
				if (hadPassword) {
					transaction
						.delete(settings)
						.where(eq(settings.key, EMAIL_SETTING_DEFINITIONS.smtpPassword.storedAs))
						.run();
					auditChange(transaction, actorUserId, 'smtpPassword', { password: 'cleared' }, now);
				}
				break;
		}
		return readEmailSettings(transaction);
	});
}
