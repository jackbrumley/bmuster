import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateEmailSettingsRequestSchema } from '#lib/schemas/email/email.ts';
import { settings } from '../../database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { emailSettingsFor, SECRETS_KEY, setUpEmail } from '#tests/helpers/email.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { readableBody, startSmtpSink, type SmtpSink } from '#tests/helpers/smtp-sink.ts';
import { listAudit } from '../audit/audit.ts';
import { listRecentEmails } from '../email/email-queue.ts';
import { sendSmtp } from '../email/smtp.ts';
import { sendTestEmail } from '../email/test-email.ts';
import {
	emailReadiness,
	emailSetup,
	readEmailSettings,
	updateEmailSettings
} from './email-settings.ts';

let sink: SmtpSink;

beforeAll(async () => {
	sink = await startSmtpSink();
});

afterAll(async () => {
	await sink.close();
});

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: PASSWORD
	});
	return { database, admin };
}

describe('email settings (E1)', () => {
	it('starts off, with SMTP defaults and no password', async () => {
		const { database } = await setUp();
		expect(readEmailSettings(database)).toEqual({
			enabled: false,
			fromName: 'BMuster',
			fromAddress: '',
			consoleUrl: '',
			smtpHost: '',
			smtpPort: 587,
			smtpSecurity: 'starttls',
			smtpUsername: '',
			password: { kind: 'not-set' }
		});
		expect(emailReadiness(database)).toEqual({ kind: 'off' });
	});

	it('saves every field and audits each change, never the password itself', async () => {
		const { database, admin } = await setUp();
		const view = updateEmailSettings(
			database,
			admin.id,
			{
				...emailSettingsFor(2525),
				smtpSecurity: 'tls',
				smtpUsername: 'mailer',
				smtpPassword: { kind: 'replace', value: 'smtp-secret-123' }
			},
			SECRETS_KEY,
			NOW
		);
		expect(view).toMatchObject({
			enabled: true,
			smtpHost: '127.0.0.1',
			smtpPort: 2525,
			smtpSecurity: 'tls',
			password: { kind: 'set' }
		});
		expect(emailReadiness(database)).toEqual({ kind: 'ready' });
		const entries = listAudit(database, 50).filter((entry) => entry.kind === 'setting-changed');
		expect(entries.map((entry) => entry.target)).toContain('Email: Password');
		expect(JSON.stringify(entries)).not.toContain('smtp-secret-123');
	});

	it('seals the password with SECRETS_KEY: the stored row is not the password', async () => {
		const { database, admin } = await setUp();
		updateEmailSettings(
			database,
			admin.id,
			{
				...emailSettingsFor(2525),
				smtpUsername: 'mailer',
				smtpPassword: { kind: 'replace', value: 'smtp-secret-123' }
			},
			SECRETS_KEY,
			NOW
		);
		const stored = database.select().from(settings).all();
		expect(JSON.stringify(stored)).not.toContain('smtp-secret-123');
		const setup = emailSetup(database, SECRETS_KEY, 'queue');
		expect(setup).toMatchObject({
			kind: 'ready',
			smtp: { auth: { kind: 'password', username: 'mailer', password: 'smtp-secret-123' } }
		});
	});

	it('keeps the password when the page sends "keep", and clears it on "clear"', async () => {
		const { database, admin } = await setUp();
		const base = { ...emailSettingsFor(2525), smtpUsername: 'mailer' };
		updateEmailSettings(
			database,
			admin.id,
			{ ...base, smtpPassword: { kind: 'replace', value: 'first-secret' } },
			SECRETS_KEY,
			NOW
		);
		expect(updateEmailSettings(database, admin.id, base, SECRETS_KEY, NOW).password).toEqual({
			kind: 'set'
		});
		expect(
			updateEmailSettings(
				database,
				admin.id,
				{ ...base, smtpPassword: { kind: 'clear' } },
				SECRETS_KEY,
				NOW
			).password
		).toEqual({ kind: 'not-set' });
	});

	it('refuses to turn email on without a from address, console address and server', () => {
		const parsed = updateEmailSettingsRequestSchema.safeParse({
			...emailSettingsFor(587),
			fromAddress: '',
			consoleUrl: '',
			smtpHost: ''
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path[0])).toEqual([
			'fromAddress',
			'consoleUrl',
			'smtpHost'
		]);
	});

	it('keeps the console address without a trailing slash and refuses other schemes', () => {
		const ok = updateEmailSettingsRequestSchema.parse({
			...emailSettingsFor(587),
			consoleUrl: 'https://bmuster.example.com/'
		});
		expect(ok.consoleUrl).toBe('https://bmuster.example.com');
		expect(
			updateEmailSettingsRequestSchema.safeParse({
				...emailSettingsFor(587),
				consoleUrl: 'javascript:alert(1)'
			}).success
		).toBe(false);
	});
});

describe('send a test email (E2)', () => {
	it('sends at once and shows the server reply; recorded and audited', async () => {
		const { database, admin } = await setUp();
		setUpEmail(database, admin.id, sink.port);
		const before = sink.messages.length;
		const result = await sendTestEmail(
			database,
			{ userId: admin.id, name: admin.name },
			'someone@example.test',
			SECRETS_KEY,
			sendSmtp,
			() => NOW
		);
		expect(result.kind).toBe('sent');
		expect(result.kind === 'sent' ? result.reply : '').toContain('Accepted by 127.0.0.1');
		const message = sink.messages[before];
		expect(message?.to).toEqual(['<someone@example.test>']);
		expect(readableBody(message?.raw ?? '')).toContain('Email works');
		expect(listRecentEmails(database, 10)[0]).toMatchObject({
			kind: 'test',
			to: 'someone@example.test',
			status: { kind: 'sent' }
		});
		expect(listAudit(database, 5)[0]).toMatchObject({
			kind: 'email-sent',
			target: 'someone@example.test'
		});
	});

	it('works while email is still off, so settings can be tried first', async () => {
		const { database, admin } = await setUp();
		updateEmailSettings(
			database,
			admin.id,
			{ ...emailSettingsFor(sink.port), enabled: false },
			SECRETS_KEY,
			NOW
		);
		const result = await sendTestEmail(
			database,
			{ userId: admin.id, name: admin.name },
			'someone@example.test',
			SECRETS_KEY,
			sendSmtp,
			() => NOW
		);
		expect(result.kind).toBe('sent');
	});

	it('shows the exact error when the server cannot be reached', async () => {
		const { database, admin } = await setUp();
		setUpEmail(database, admin.id, 1);
		const result = await sendTestEmail(
			database,
			{ userId: admin.id, name: admin.name },
			'someone@example.test',
			SECRETS_KEY,
			sendSmtp,
			() => NOW
		);
		expect(result.kind).toBe('failed');
		expect(result.kind === 'failed' ? result.error : '').toMatch(/ECONNREFUSED|connect/i);
		expect(listAudit(database, 5)[0]?.kind).toBe('email-failed');
	});

	it('shows the refusal word for word when the server refuses the recipient', async () => {
		const { database, admin } = await setUp();
		setUpEmail(database, admin.id, sink.port);
		sink.refuseRecipients = true;
		try {
			const result = await sendTestEmail(
				database,
				{ userId: admin.id, name: admin.name },
				'someone@example.test',
				SECRETS_KEY,
				sendSmtp,
				() => NOW
			);
			expect(result.kind === 'failed' ? result.error : '').toContain(
				'Recipient refused by the test sink'
			);
		} finally {
			sink.refuseRecipients = false;
		}
	});

	it('signs in to the server with the opened password', async () => {
		const { database, admin } = await setUp();
		updateEmailSettings(
			database,
			admin.id,
			{
				...emailSettingsFor(sink.port),
				smtpUsername: 'mailer',
				smtpPassword: { kind: 'replace', value: 'smtp-secret-123' }
			},
			SECRETS_KEY,
			NOW
		);
		const before = sink.messages.length;
		await sendTestEmail(
			database,
			{ userId: admin.id, name: admin.name },
			'someone@example.test',
			SECRETS_KEY,
			sendSmtp,
			() => NOW
		);
		expect(sink.messages[before]?.auth).toEqual({
			kind: 'signed-in',
			username: 'mailer',
			password: 'smtp-secret-123'
		});
	});

	it('refuses STARTTLS servers that will not upgrade, instead of sending in plain text', async () => {
		const { database, admin } = await setUp();
		updateEmailSettings(
			database,
			admin.id,
			{ ...emailSettingsFor(sink.port), smtpSecurity: 'starttls' },
			SECRETS_KEY,
			NOW
		);
		const before = sink.messages.length;
		const result = await sendTestEmail(
			database,
			{ userId: admin.id, name: admin.name },
			'someone@example.test',
			SECRETS_KEY,
			sendSmtp,
			() => NOW
		);
		expect(result.kind).toBe('failed');
		expect(sink.messages.length).toBe(before);
	});
});
