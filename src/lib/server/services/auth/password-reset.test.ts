import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailMessages, identityProviders, userIdentities } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { CONSOLE_URL, SECRETS_KEY, setUpEmail } from '#tests/helpers/email.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { readableBody, startSmtpSink, type SmtpSink } from '#tests/helpers/smtp-sink.ts';
import { listAudit } from '../audit/audit.ts';
import { deliverDueEmails } from '../email/email-queue.ts';
import { sendSmtp } from '../email/smtp.ts';
import { disableUser } from '../users/users.ts';
import { signInWithPassword } from './password-sign-in.ts';
import { requestPasswordReset, resetPassword } from './password-reset.ts';
import { sessionCount, startSession } from './sessions.ts';

let sink: SmtpSink;

beforeAll(async () => {
	sink = await startSmtpSink();
});

afterAll(async () => {
	await sink.close();
});

const NEW_PASSWORD = 'a brand new password';

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: PASSWORD
	});
	const member = await addTestUser(database, {
		email: 'member@example.test',
		role: 'member',
		password: PASSWORD
	});
	setUpEmail(database, admin.id, sink.port);
	return { database, admin, member };
}

/** Sends what is queued to the sink and returns the reset token from the newest email. */
async function deliverAndReadLink(database: AppDatabase, now: number): Promise<string> {
	const before = sink.messages.length;
	await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => now);
	const body = readableBody(sink.messages[before]?.raw ?? '');
	const match = /https:\/\/bmuster\.test\/login\/reset\/([A-Za-z0-9_-]+)/.exec(body);
	if (match?.[1] === undefined) {
		throw new Error('No reset link in the email');
	}
	return match[1];
}

function queued(database: AppDatabase) {
	return database.select().from(emailMessages).all();
}

describe('forgot password (E4)', () => {
	it('emails a password account a link that sets a new password once', async () => {
		const { database } = await setUp();
		expect(requestPasswordReset(database, 'Member@Example.test', SECRETS_KEY, NOW)).toEqual({
			kind: 'accepted'
		});
		const token = await deliverAndReadLink(database, NOW);
		expect(sink.messages.at(-1)?.to).toEqual(['<member@example.test>']);
		expect(await resetPassword(database, token, NEW_PASSWORD, NOW + 60_000)).toEqual({
			kind: 'done'
		});
		const signedIn = await signInWithPassword(
			database,
			{ email: 'member@example.test', password: NEW_PASSWORD },
			CLIENT,
			NOW + 61_000
		);
		expect(signedIn.kind).toBe('signed-in');
		// Single use.
		expect(await resetPassword(database, token, 'another new password', NOW + 62_000)).toEqual({
			kind: 'link-unusable'
		});
		expect(listAudit(database, 10).map((entry) => entry.kind)).toEqual(
			expect.arrayContaining(['password-reset-requested', 'password-reset'])
		);
	});

	it('builds the link from the console address in the settings, never from the request', async () => {
		const { database } = await setUp();
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		await deliverAndReadLink(database, NOW);
		expect(readableBody(sink.messages.at(-1)?.raw ?? '')).toContain(`${CONSOLE_URL}/login/reset/`);
	});

	it('expires the link after 30 minutes', async () => {
		const { database } = await setUp();
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		const token = await deliverAndReadLink(database, NOW);
		expect(await resetPassword(database, token, NEW_PASSWORD, NOW + 30 * 60_000)).toEqual({
			kind: 'link-unusable'
		});
	});

	it('says the same for an address nobody has, and sends nothing', async () => {
		const { database } = await setUp();
		expect(requestPasswordReset(database, 'nobody@example.test', SECRETS_KEY, NOW)).toEqual({
			kind: 'accepted'
		});
		expect(queued(database)).toHaveLength(0);
	});

	it('tells someone who signs in through a provider to use it, with no reset link', async () => {
		const { database } = await setUp();
		const person = await addTestUser(database, {
			email: 'entra@example.test',
			role: 'member',
			password: null
		});
		database
			.insert(identityProviders)
			.values({
				id: crypto.randomUUID(),
				name: 'Contoso Entra',
				kind: 'microsoft-entra',
				issuer: 'https://login.example.test',
				clientId: 'client',
				clientSecretSealed: '',
				scopes: '["openid"]',
				newPeople: 'invited',
				enabled: true,
				createdAt: new Date(NOW)
			})
			.run();
		const provider = database.select().from(identityProviders).get();
		database
			.insert(userIdentities)
			.values({
				id: crypto.randomUUID(),
				userId: person.id,
				providerId: provider?.id ?? '',
				subject: 'sub-1'
			})
			.run();
		expect(requestPasswordReset(database, 'entra@example.test', SECRETS_KEY, NOW)).toEqual({
			kind: 'accepted'
		});
		expect(queued(database).map((row) => row.kind)).toEqual(['provider-sign-in']);
		const before = sink.messages.length;
		await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW);
		const body = readableBody(sink.messages[before]?.raw ?? '');
		expect(body).toContain('Contoso Entra');
		expect(body).not.toContain('/login/reset/');
	});

	it('sends at most one email per address every few minutes', async () => {
		const { database } = await setUp();
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW + 30_000);
		expect(queued(database)).toHaveLength(1);
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW + 3 * 60_000);
		expect(queued(database)).toHaveLength(2);
	});

	it('cancels an earlier link when a new one is sent', async () => {
		const { database } = await setUp();
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		const first = await deliverAndReadLink(database, NOW);
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW + 3 * 60_000);
		await deliverAndReadLink(database, NOW + 3 * 60_000);
		expect(await resetPassword(database, first, NEW_PASSWORD, NOW + 4 * 60_000)).toEqual({
			kind: 'link-unusable'
		});
	});

	it('signs the person out everywhere when the password is reset', async () => {
		const { database, member } = await setUp();
		startSession(database, member.id, CLIENT, NOW);
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		const token = await deliverAndReadLink(database, NOW);
		await resetPassword(database, token, NEW_PASSWORD, NOW + 1000);
		expect(sessionCount(database, member.id)).toBe(0);
	});

	it('sends nothing to a disabled account, and its links stop working', async () => {
		const { database, admin, member } = await setUp();
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW);
		const token = await deliverAndReadLink(database, NOW);
		disableUser(database, admin.id, member.id, NOW);
		expect(await resetPassword(database, token, NEW_PASSWORD, NOW + 1000)).toEqual({
			kind: 'link-unusable'
		});
		requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW + 10 * 60_000);
		expect(queued(database)).toHaveLength(1);
	});

	it('says email is off when it is, whatever the address', async () => {
		const database = testDatabase();
		await addTestUser(database, {
			email: 'member@example.test',
			role: 'member',
			password: PASSWORD
		});
		expect(requestPasswordReset(database, 'member@example.test', SECRETS_KEY, NOW)).toEqual({
			kind: 'email-off'
		});
		expect(requestPasswordReset(database, 'nobody@example.test', SECRETS_KEY, NOW)).toEqual({
			kind: 'email-off'
		});
	});
});
