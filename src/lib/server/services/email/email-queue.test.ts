import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailMessages } from '../../database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { emailSettingsFor, SECRETS_KEY, setUpEmail } from '#tests/helpers/email.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { readableBody, startSmtpSink, type SmtpSink } from '#tests/helpers/smtp-sink.ts';
import { listAudit } from '../audit/audit.ts';
import { updateEmailSettings } from '../settings/email-settings.ts';
import {
	deliverDueEmails,
	enqueueEmail,
	listRecentEmails,
	MAX_ATTEMPTS,
	retryDelayMs,
	type Sender
} from './email-queue.ts';
import { sendSmtp } from './smtp.ts';
import { renderEmail } from './templates.ts';

let sink: SmtpSink;

beforeAll(async () => {
	sink = await startSmtpSink();
});

afterAll(async () => {
	await sink.close();
});

const EMAIL = renderEmail({
	subject: 'Hello',
	heading: 'Hello',
	blocks: [{ kind: 'paragraph', text: 'A queued message.' }],
	footer: 'Test.'
});

const ALWAYS_FAILS: Sender = () =>
	Promise.resolve({ kind: 'failed', error: '421 4.7.0 Try again later' });

async function setUp(port: number) {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: PASSWORD
	});
	setUpEmail(database, admin.id, port);
	return { database, admin };
}

describe('the email queue (E3)', () => {
	it('backs off from 1 minute, doubling, to at most 1 hour', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => retryDelayMs(attempt) / 60_000)).toEqual([
			1, 2, 4, 8, 16, 32, 60, 60
		]);
		expect(MAX_ATTEMPTS).toBe(8);
	});

	it('sends a queued message through SMTP and records it as sent', async () => {
		const { database } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'notification', to: 'one@example.test', email: EMAIL },
			{ kind: 'plain' },
			NOW
		);
		const before = sink.messages.length;
		const run = await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW);
		expect(run).toEqual({ sent: 1, retrying: 0, failed: 0 });
		expect(readableBody(sink.messages[before]?.raw ?? '')).toContain('A queued message.');
		expect(listRecentEmails(database, 5)[0]?.status.kind).toBe('sent');
	});

	it('retries a failing message on the back-off schedule and gives up after 8 tries, visibly', async () => {
		const { database } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'notification', to: 'two@example.test', email: EMAIL },
			{ kind: 'plain' },
			NOW
		);
		let now = NOW;
		for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
			const run = await deliverDueEmails(database, SECRETS_KEY, ALWAYS_FAILS, () => now);
			expect(run.retrying).toBe(1);
			const [view] = listRecentEmails(database, 1);
			expect(view?.status).toEqual({
				kind: 'queued',
				attempts: attempt,
				nextAttemptIso: new Date(now + retryDelayMs(attempt)).toISOString(),
				lastError: '421 4.7.0 Try again later'
			});
			// Not due yet: nothing is tried.
			expect(await deliverDueEmails(database, SECRETS_KEY, ALWAYS_FAILS, () => now + 1)).toEqual({
				sent: 0,
				retrying: 0,
				failed: 0
			});
			now += retryDelayMs(attempt);
		}
		const last = await deliverDueEmails(database, SECRETS_KEY, ALWAYS_FAILS, () => now);
		expect(last.failed).toBe(1);
		expect(listRecentEmails(database, 1)[0]?.status).toEqual({
			kind: 'failed',
			atIso: new Date(now).toISOString(),
			attempts: MAX_ATTEMPTS,
			error: '421 4.7.0 Try again later'
		});
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'email-failed',
			target: 'two@example.test',
			detail: { error: '421 4.7.0 Try again later' }
		});
	});

	it('keeps messages through a restart: a fresh worker on the same database sends them', async () => {
		const { database } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'notification', to: 'three@example.test', email: EMAIL },
			{ kind: 'plain' },
			NOW
		);
		// The first process dies after a failed try; the row is all that is left.
		await deliverDueEmails(database, SECRETS_KEY, ALWAYS_FAILS, () => NOW);
		const run = await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW + 60_000);
		expect(run.sent).toBe(1);
	});

	it('lets messages wait while email is off, without counting tries', async () => {
		const { database, admin } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'notification', to: 'four@example.test', email: EMAIL },
			{ kind: 'plain' },
			NOW
		);
		updateEmailSettings(
			database,
			admin.id,
			{ ...emailSettingsFor(sink.port), enabled: false },
			SECRETS_KEY,
			NOW
		);
		expect(await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW)).toEqual({
			sent: 0,
			retrying: 0,
			failed: 0
		});
		expect(listRecentEmails(database, 1)[0]?.status).toMatchObject({ kind: 'queued', attempts: 0 });
	});
});

describe('the record of sent and failed email (E8)', () => {
	it('keeps recipient, subject, time and result, and wipes the body once sent', async () => {
		const { database } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'password-reset', to: 'five@example.test', email: EMAIL },
			{ kind: 'sealed', secretsKey: SECRETS_KEY },
			NOW
		);
		await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW + 5);
		const [row] = database.select().from(emailMessages).all();
		expect(row).toMatchObject({
			toAddress: 'five@example.test',
			subject: 'Hello',
			status: 'sent',
			body: null,
			finishedAt: new Date(NOW + 5)
		});
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'email-sent',
			target: 'five@example.test',
			detail: { email: 'password-reset', subject: 'Hello' }
		});
	});

	it('seals a password-reset body while it waits, so the database never holds the link in clear', async () => {
		const { database } = await setUp(sink.port);
		const reset = renderEmail({
			subject: 'Reset',
			heading: 'Reset',
			blocks: [{ kind: 'button', label: 'Go', url: 'https://bmuster.test/login/reset/SECRET' }],
			footer: 'Test.'
		});
		enqueueEmail(
			database,
			{ kind: 'password-reset', to: 'six@example.test', email: reset },
			{ kind: 'sealed', secretsKey: SECRETS_KEY },
			NOW
		);
		const [row] = database.select().from(emailMessages).all();
		expect(row?.body).not.toContain('SECRET');
		expect(JSON.stringify(listAudit(database, 50))).not.toContain('SECRET');
	});

	it('wipes the body of a message it gave up on', async () => {
		const { database } = await setUp(sink.port);
		enqueueEmail(
			database,
			{ kind: 'notification', to: 'seven@example.test', email: EMAIL },
			{ kind: 'plain' },
			NOW
		);
		let now = NOW;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			await deliverDueEmails(database, SECRETS_KEY, ALWAYS_FAILS, () => now);
			now += retryDelayMs(attempt);
		}
		const [row] = database.select().from(emailMessages).all();
		expect(row).toMatchObject({ status: 'failed', body: null });
	});
});
