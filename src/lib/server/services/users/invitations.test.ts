import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailMessages } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { CONSOLE_URL, SECRETS_KEY, setUpEmail } from '#tests/helpers/email.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { readableBody, startSmtpSink, type SmtpSink } from '#tests/helpers/smtp-sink.ts';
import { listAudit } from '../audit/audit.ts';
import { signInWithPassword } from '../auth/password-sign-in.ts';
import { deliverDueEmails } from '../email/email-queue.ts';
import { sendSmtp } from '../email/smtp.ts';
import { updateSettingAsSystem } from '../settings/settings.ts';
import { acceptInvitation, addUserAndInvite, inviteUser, lookUpInvitation } from './invitations.ts';
import { toConsoleUser } from './users.ts';

let sink: SmtpSink;

beforeAll(async () => {
	sink = await startSmtpSink();
});

afterAll(async () => {
	await sink.close();
});

const ADMIN_ORIGIN = 'https://admin-browser.test';
const DAY = 24 * 60 * 60_000;

async function setUp(email: 'on' | 'off') {
	const database = testDatabase();
	const adminRow = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: PASSWORD
	});
	if (email === 'on') {
		setUpEmail(database, adminRow.id, sink.port);
	}
	return { database, admin: toConsoleUser(adminRow) };
}

const context = { secretsKey: SECRETS_KEY, adminOrigin: ADMIN_ORIGIN };

function tokenFrom(url: string): string {
	const token = url.split('/invite/')[1];
	if (token === undefined) {
		throw new Error(`No invitation token in ${url}`);
	}
	return token;
}

async function deliverAndReadInvite(database: AppDatabase): Promise<string> {
	const before = sink.messages.length;
	await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW);
	const body = readableBody(sink.messages[before]?.raw ?? '');
	const match = /https:\/\/bmuster\.test\/invite\/[A-Za-z0-9_-]+/.exec(body);
	if (match === null) {
		throw new Error('No invitation link in the email');
	}
	return match[0];
}

describe('invitations (E5)', () => {
	it('emails an invitation when email is set up; the link sets a password and signs them in', async () => {
		const { database, admin } = await setUp('on');
		const added = await addUserAndInvite(
			database,
			admin,
			{ name: 'Ada', email: 'ada@example.test', role: 'member', signIn: { kind: 'invite' } },
			context,
			NOW
		);
		expect(added).toMatchObject({
			kind: 'done',
			invitation: { kind: 'emailed', to: 'ada@example.test' }
		});
		const url = await deliverAndReadInvite(database);
		expect(url.startsWith(`${CONSOLE_URL}/invite/`)).toBe(true);
		expect(readableBody(sink.messages.at(-1)?.raw ?? '')).toContain('invited you');
		const token = tokenFrom(url);
		expect(lookUpInvitation(database, token, NOW)).toEqual({
			kind: 'usable',
			name: 'Ada',
			email: 'ada@example.test'
		});
		const accepted = await acceptInvitation(
			database,
			token,
			'ada chooses this',
			CLIENT,
			NOW + 1000
		);
		expect(accepted.kind).toBe('accepted');
		const signIn = await signInWithPassword(
			database,
			{ email: 'ada@example.test', password: 'ada chooses this' },
			CLIENT,
			NOW + 2000
		);
		expect(signIn.kind).toBe('signed-in');
		expect(lookUpInvitation(database, token, NOW + 3000)).toEqual({ kind: 'unusable' });
		expect(listAudit(database, 20).map((entry) => entry.kind)).toEqual(
			expect.arrayContaining(['user-added', 'invitation-created', 'invitation-accepted'])
		);
	});

	it('gives the admin a link to pass on when email is not set up', async () => {
		const { database, admin } = await setUp('off');
		const added = await addUserAndInvite(
			database,
			admin,
			{ name: 'Ada', email: 'ada@example.test', role: 'member', signIn: { kind: 'invite' } },
			context,
			NOW
		);
		expect(added.kind === 'done' ? added.invitation : undefined).toMatchObject({
			kind: 'link',
			expiresIso: new Date(NOW + 7 * DAY).toISOString()
		});
		expect(database.select().from(emailMessages).all()).toHaveLength(0);
		const url =
			added.kind === 'done' && added.invitation.kind === 'link' ? added.invitation.url : '';
		expect(url.startsWith(`${ADMIN_ORIGIN}/invite/`)).toBe(true);
		const accepted = await acceptInvitation(
			database,
			tokenFrom(url),
			'ada chooses this',
			CLIENT,
			NOW + 1000
		);
		expect(accepted.kind).toBe('accepted');
	});

	it('signs them in, or takes them to two-factor set-up when it is required (SPEC-TWO-FACTOR TF8)', async () => {
		const { database, admin } = await setUp('off');
		for (const [email, policy] of [
			['ada@example.test', 'admins'],
			['bea@example.test', 'everyone']
		] as const) {
			updateSettingAsSystem(database, 'twoFactorSignIn', policy, 'test', NOW);
			const added = await addUserAndInvite(
				database,
				admin,
				{ name: email, email, role: 'member', signIn: { kind: 'invite' } },
				context,
				NOW
			);
			const url =
				added.kind === 'done' && added.invitation.kind === 'link' ? added.invitation.url : '';
			const accepted = await acceptInvitation(
				database,
				tokenFrom(url),
				'they choose this',
				CLIENT,
				NOW + 1000
			);
			expect(accepted, policy).toMatchObject(
				policy === 'admins'
					? { kind: 'accepted', next: { kind: 'session' } }
					: { kind: 'accepted', next: { kind: 'challenge', challenge: { step: 'set-up' } } }
			);
		}
	});

	it('lasts 7 days', async () => {
		const { database, admin } = await setUp('off');
		const added = await addUserAndInvite(
			database,
			admin,
			{ name: 'Ada', email: 'ada@example.test', role: 'member', signIn: { kind: 'invite' } },
			context,
			NOW
		);
		const url =
			added.kind === 'done' && added.invitation.kind === 'link' ? added.invitation.url : '';
		expect(lookUpInvitation(database, tokenFrom(url), NOW + 7 * DAY - 1).kind).toBe('usable');
		expect(lookUpInvitation(database, tokenFrom(url), NOW + 7 * DAY).kind).toBe('unusable');
	});

	it('tells a provider-only account to sign in with its provider, with no password link', async () => {
		const { database, admin } = await setUp('on');
		const added = await addUserAndInvite(
			database,
			admin,
			{ name: 'Bo', email: 'bo@example.test', role: 'member', signIn: { kind: 'provider' } },
			context,
			NOW
		);
		expect(added).toMatchObject({ kind: 'done', invitation: { kind: 'emailed' } });
		const before = sink.messages.length;
		await deliverDueEmails(database, SECRETS_KEY, sendSmtp, () => NOW);
		const body = readableBody(sink.messages[before]?.raw ?? '');
		expect(body).toContain('Continue with your provider');
		expect(body).not.toContain('/invite/');
	});

	it('adds someone with a password straight away and sends nothing', async () => {
		const { database, admin } = await setUp('on');
		const added = await addUserAndInvite(
			database,
			admin,
			{
				name: 'Cy',
				email: 'cy@example.test',
				role: 'member',
				signIn: { kind: 'password', value: 'a password set now' }
			},
			context,
			NOW
		);
		expect(added).toMatchObject({ kind: 'done', invitation: { kind: 'none' } });
		expect(database.select().from(emailMessages).all()).toHaveLength(0);
	});

	it('sends a fresh invitation on request, and the old link stops working', async () => {
		const { database, admin } = await setUp('off');
		const added = await addUserAndInvite(
			database,
			admin,
			{ name: 'Ada', email: 'ada@example.test', role: 'member', signIn: { kind: 'invite' } },
			context,
			NOW
		);
		if (added.kind !== 'done' || added.invitation.kind !== 'link') {
			throw new Error('Expected a link');
		}
		const again = inviteUser(database, admin, added.user.id, context, NOW + 1000);
		expect(again).toMatchObject({ kind: 'done', invitation: { kind: 'link' } });
		expect(lookUpInvitation(database, tokenFrom(added.invitation.url), NOW + 2000).kind).toBe(
			'unusable'
		);
	});

	it('refuses to invite someone who already has a password', async () => {
		const { database, admin } = await setUp('off');
		const person = await addTestUser(database, {
			email: 'has@example.test',
			role: 'member',
			password: PASSWORD
		});
		expect(inviteUser(database, admin, person.id, context, NOW)).toMatchObject({
			kind: 'refused',
			status: 409
		});
	});
});
