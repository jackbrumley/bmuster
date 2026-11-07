import { createMessage } from '@upyo/core';
import { SmtpTransport } from '@upyo/smtp';
import type { SendResult } from '#lib/domain/email/email-message.ts';
import type { SmtpSettings } from '../settings/email-settings.ts';
import type { RenderedEmail } from './templates.ts';

/**
 * Hands one message to the SMTP server (SPEC-EMAIL section 5), the way the
 * Wannon portal does: one connection per send, short timeouts, and STARTTLS
 * meaning TLS or nothing. The result carries the server's reply or the exact
 * error, for the queue's record and the test email.
 */
const TIMEOUT_MS = 15_000;

export async function sendSmtp(
	smtp: SmtpSettings,
	to: string,
	email: RenderedEmail
): Promise<SendResult> {
	const transport = new SmtpTransport({
		host: smtp.host,
		port: smtp.port,
		secure: smtp.security === 'tls',
		requireTls: smtp.security === 'starttls',
		...(smtp.auth.kind === 'password'
			? { auth: { user: smtp.auth.username, pass: smtp.auth.password } }
			: {}),
		pool: false,
		connectionTimeout: TIMEOUT_MS,
		socketTimeout: TIMEOUT_MS
	});
	try {
		const receipt = await transport.send(
			createMessage({
				from: { name: smtp.fromName, address: fromAddress(smtp.fromAddress) },
				to,
				subject: email.subject,
				content: { text: email.text, html: email.html }
			})
		);
		if (!receipt.successful) {
			return { kind: 'failed', error: receipt.errorMessages.join('; ') };
		}
		return { kind: 'sent', reply: `Accepted by ${smtp.host} (${receipt.messageId})` };
	} catch (error) {
		return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
	} finally {
		await transport.closeAllConnections();
	}
}

/** upyo types an address as `local@domain`; the settings schema already checked it is one. */
function fromAddress(address: string): `${string}@${string}` {
	const at = address.indexOf('@');
	if (at < 1) {
		throw new Error(`The from address ${address} is not an email address`);
	}
	return `${address.slice(0, at)}@${address.slice(at + 1)}`;
}
