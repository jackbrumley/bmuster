import type { AppDatabase } from '#lib/server/database/connection.ts';
import type { UpdateEmailSettingsRequest } from '#lib/schemas/email/email.ts';
import { updateEmailSettings } from '#lib/server/services/settings/email-settings.ts';
import { NOW } from './people.ts';

/** The key the unit test project sets as SECRETS_KEY. */
export const SECRETS_KEY = Buffer.alloc(32, 1);

export const CONSOLE_URL = 'https://bmuster.test';

/** Email switched on and pointed at a local SMTP sink, with no sign-in. */
export function emailSettingsFor(port: number): UpdateEmailSettingsRequest {
	return {
		enabled: true,
		fromName: 'BMuster',
		fromAddress: 'bmuster@example.test',
		consoleUrl: CONSOLE_URL,
		smtpHost: '127.0.0.1',
		smtpPort: port,
		smtpSecurity: 'none',
		smtpUsername: '',
		smtpPassword: { kind: 'keep' }
	};
}

export function setUpEmail(database: AppDatabase, adminId: string, port: number): void {
	updateEmailSettings(database, adminId, emailSettingsFor(port), SECRETS_KEY, NOW);
}
