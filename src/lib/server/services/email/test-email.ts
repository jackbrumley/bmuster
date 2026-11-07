import type { SendResult } from '#lib/domain/email/email-message.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { emailSetup } from '../settings/email-settings.ts';
import { recordSentNow, type Sender } from './email-queue.ts';
import { testEmail } from './templates.ts';

/**
 * Send a test email (SPEC-EMAIL E2): straight away, not through the queue,
 * so the admin sees the server's reply or the exact error. It works with the
 * saved settings even while email is off, so they can be tried first. The
 * send is recorded and audited like any other.
 */
export async function sendTestEmail(
	database: AppDatabase,
	actor: { userId: string; name: string },
	to: string,
	secretsKey: Buffer,
	send: Sender,
	now: () => number
): Promise<SendResult> {
	const setup = emailSetup(database, secretsKey, 'test');
	if (setup.kind === 'not-ready') {
		return { kind: 'failed', error: setup.reason };
	}
	const email = testEmail(actor.name);
	const result = await send(setup.smtp, to, email);
	database.transaction((transaction) => {
		recordSentNow(
			transaction,
			{ kind: 'test', to, subject: email.subject, result },
			{ kind: 'user', userId: actor.userId },
			now()
		);
	});
	return result;
}
