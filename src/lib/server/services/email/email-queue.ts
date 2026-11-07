import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailKind, EmailMessageView, SendResult } from '#lib/domain/email/email-message.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { emailMessages } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { emailSetup, type SmtpSettings } from '../settings/email-settings.ts';
import type { RenderedEmail } from './templates.ts';

/**
 * The durable send queue (SPEC-EMAIL E3, E8). A queued message is a row, so
 * nothing is lost on restart. Each try that fails waits longer: 1 minute,
 * doubling to at most 1 hour, and after 8 tries the message is given up and
 * shown as failed. A body holding a link that sets a password is sealed with
 * SECRETS_KEY while it waits; every body is wiped once the message is sent or
 * given up, so the record keeps who, what subject, when and the result, never
 * a reset link. Every outcome is audited.
 */
export const MAX_ATTEMPTS = 8;

const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 60 * 60_000;

/** How long to wait after the `attempts`-th failed try. */
export function retryDelayMs(attempts: number): number {
	return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), LONGEST_RETRY_MS);
}

const contentSchema = z.object({ text: z.string(), html: z.string() });
const bodySchema = z.union([contentSchema, z.object({ sealed: z.string() })]);

/** Sends one message; the real one is SMTP, tests may pass their own. */
export type Sender = (smtp: SmtpSettings, to: string, email: RenderedEmail) => Promise<SendResult>;

/**
 * Puts a message in the queue; call inside the transaction that caused it.
 * `sealed` seals the body with SECRETS_KEY: for a message that carries a
 * link which sets a password.
 */
export function enqueueEmail(
	database: Queryable,
	message: { kind: EmailKind; to: string; email: RenderedEmail },
	sealing: { kind: 'plain' } | { kind: 'sealed'; secretsKey: Buffer },
	now: number
): void {
	const content = JSON.stringify({ text: message.email.text, html: message.email.html });
	const body =
		sealing.kind === 'plain'
			? content
			: JSON.stringify({ sealed: sealSecret(Buffer.from(content, 'utf8'), sealing.secretsKey) });
	database
		.insert(emailMessages)
		.values({
			id: crypto.randomUUID(),
			kind: message.kind,
			toAddress: message.to,
			subject: message.email.subject,
			body,
			status: 'queued',
			attempts: 0,
			nextAttemptAt: new Date(now),
			lastError: null,
			reply: null,
			createdAt: new Date(now),
			finishedAt: null
		})
		.run();
}

/** Whether a message of one of these kinds went into the queue for this address since `since`. */
export function queuedSince(
	database: Queryable,
	to: string,
	kinds: readonly EmailKind[],
	since: number
): boolean {
	return (
		database
			.select({ id: emailMessages.id })
			.from(emailMessages)
			.where(
				and(
					eq(emailMessages.toAddress, to),
					inArray(emailMessages.kind, [...kinds]),
					gt(emailMessages.createdAt, new Date(since))
				)
			)
			.limit(1)
			.get() !== undefined
	);
}

/** Records a message sent straight away (the test email), with its result. */
export function recordSentNow(
	database: Queryable,
	message: { kind: EmailKind; to: string; subject: string; result: SendResult },
	actor: { kind: 'user'; userId: string },
	now: number
): void {
	database
		.insert(emailMessages)
		.values({
			id: crypto.randomUUID(),
			kind: message.kind,
			toAddress: message.to,
			subject: message.subject,
			body: null,
			status: message.result.kind,
			attempts: 1,
			nextAttemptAt: new Date(now),
			lastError: message.result.kind === 'failed' ? message.result.error : null,
			reply: message.result.kind === 'sent' ? message.result.reply : null,
			createdAt: new Date(now),
			finishedAt: new Date(now)
		})
		.run();
	auditOutcome(database, actor, message.kind, message.to, message.subject, message.result, now);
}

function auditOutcome(
	database: Queryable,
	actor: { kind: 'system' } | { kind: 'user'; userId: string },
	kind: EmailKind,
	to: string,
	subject: string,
	result: SendResult,
	now: number
): void {
	recordAudit(
		database,
		{
			actor,
			kind: result.kind === 'sent' ? 'email-sent' : 'email-failed',
			target: to,
			machineId: null,
			detail:
				result.kind === 'sent'
					? { email: kind, subject, reply: result.reply }
					: { email: kind, subject, error: result.error }
		},
		now
	);
}

type QueueRun = { sent: number; retrying: number; failed: number };

/**
 * Tries every message that is due, one at a time. While email is off or not
 * set up, messages wait (they are not counted as tries).
 */
export async function deliverDueEmails(
	database: AppDatabase,
	secretsKey: Buffer,
	send: Sender,
	now: () => number
): Promise<QueueRun> {
	const run: QueueRun = { sent: 0, retrying: 0, failed: 0 };
	const setup = emailSetup(database, secretsKey, 'queue');
	if (setup.kind === 'not-ready') {
		return run;
	}
	const due = database
		.select()
		.from(emailMessages)
		.where(
			and(eq(emailMessages.status, 'queued'), lte(emailMessages.nextAttemptAt, new Date(now())))
		)
		.orderBy(asc(emailMessages.nextAttemptAt))
		.limit(50)
		.all();
	for (const row of due) {
		const result = await sendRow(row, setup.smtp, secretsKey, send);
		const at = now();
		const attempts = row.attempts + 1;
		database.transaction((transaction) => {
			if (result.kind === 'sent' || attempts >= MAX_ATTEMPTS) {
				transaction
					.update(emailMessages)
					.set({
						status: result.kind,
						attempts,
						body: null,
						reply: result.kind === 'sent' ? result.reply : null,
						lastError: result.kind === 'failed' ? result.error : null,
						finishedAt: new Date(at)
					})
					.where(eq(emailMessages.id, row.id))
					.run();
				auditOutcome(
					transaction,
					{ kind: 'system' },
					row.kind,
					row.toAddress,
					row.subject,
					result,
					at
				);
				return;
			}
			transaction
				.update(emailMessages)
				.set({
					attempts,
					lastError: result.error,
					nextAttemptAt: new Date(at + retryDelayMs(attempts))
				})
				.where(eq(emailMessages.id, row.id))
				.run();
		});
		if (result.kind === 'sent') {
			run.sent += 1;
		} else if (attempts >= MAX_ATTEMPTS) {
			run.failed += 1;
		} else {
			run.retrying += 1;
		}
	}
	return run;
}

async function sendRow(
	row: typeof emailMessages.$inferSelect,
	smtp: SmtpSettings,
	secretsKey: Buffer,
	send: Sender
): Promise<SendResult> {
	if (row.body === null) {
		return { kind: 'failed', error: 'The message has no body to send.' };
	}
	const body = bodySchema.parse(JSON.parse(row.body));
	const content =
		'sealed' in body
			? contentSchema.parse(JSON.parse(openSecret(body.sealed, secretsKey).toString('utf8')))
			: body;
	return send(smtp, row.toAddress, { subject: row.subject, ...content });
}

/** The newest messages first, for Settings → Email. */
export function listRecentEmails(database: Queryable, limit: number): EmailMessageView[] {
	return database
		.select()
		.from(emailMessages)
		.orderBy(desc(emailMessages.createdAt))
		.limit(limit)
		.all()
		.map(toView);
}

function toView(row: typeof emailMessages.$inferSelect): EmailMessageView {
	return {
		id: row.id,
		kind: row.kind,
		to: row.toAddress,
		subject: row.subject,
		createdIso: row.createdAt.toISOString(),
		status: statusOf(row)
	};
}

function statusOf(row: typeof emailMessages.$inferSelect): EmailMessageView['status'] {
	switch (row.status) {
		case 'queued':
			return {
				kind: 'queued',
				attempts: row.attempts,
				nextAttemptIso: row.nextAttemptAt.toISOString(),
				lastError: row.lastError
			};
		case 'sent':
			return {
				kind: 'sent',
				atIso: (row.finishedAt ?? row.createdAt).toISOString(),
				reply: row.reply ?? ''
			};
		case 'failed':
			return {
				kind: 'failed',
				atIso: (row.finishedAt ?? row.createdAt).toISOString(),
				attempts: row.attempts,
				error: row.lastError ?? ''
			};
	}
}
