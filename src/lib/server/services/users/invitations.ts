import type { Invitation, SignInChoice } from '#lib/domain/users/invitation.ts';
import type { ConsoleRole, ConsoleUser, UserView } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { signInProviders } from '../auth/identity-providers.ts';
import {
	createPasswordLink,
	findUsableLink,
	INVITATION_LINK_DAYS,
	linkPath,
	usePasswordLinks
} from '../auth/password-links.ts';
import { hashPassword } from '../auth/passwords.ts';
import { startSession, type StartedSession } from '../auth/sessions.ts';
import type { SignInClient } from '../auth/client.ts';
import { enqueueEmail } from '../email/email-queue.ts';
import { invitationEmail, providerInvitationEmail } from '../email/templates.ts';
import { emailSetup } from '../settings/email-settings.ts';
import { addUser, findUserById, markSignedIn, setPasswordHash, type UserChange } from './users.ts';

/**
 * Invitations (SPEC-EMAIL E5). An admin adds someone and chooses how they
 * sign in. "Invite" makes a single-use link (7 days) where they choose their
 * own password: emailed when email is set up, otherwise handed to the admin
 * to pass on. Someone who signs in only through a provider is emailed how to
 * sign in, with no link to set a password.
 */
export type InviteContext = {
	secretsKey: Buffer;
	/** Where the admin is using the console; links fall back to it while email is off. */
	adminOrigin: string;
};

type Refused = Extract<UserChange, { kind: 'refused' }>;

export type InvitedUser = { kind: 'done'; user: UserView; invitation: Invitation } | Refused;

export async function addUserAndInvite(
	database: AppDatabase,
	actor: ConsoleUser,
	input: { name: string; email: string; role: ConsoleRole; signIn: SignInChoice },
	context: InviteContext,
	now: number
): Promise<InvitedUser> {
	const added = await addUser(
		database,
		actor.id,
		{
			name: input.name,
			email: input.email,
			role: input.role,
			password: input.signIn.kind === 'password' ? input.signIn.value : null
		},
		now
	);
	if (added.kind === 'refused') {
		return added;
	}
	switch (input.signIn.kind) {
		case 'password':
			return { kind: 'done', user: added.user, invitation: { kind: 'none' } };
		case 'provider':
			return {
				kind: 'done',
				user: added.user,
				invitation: tellProviderSignIn(database, actor, added.user, context.secretsKey, now)
			};
		case 'invite': {
			const sent = inviteUser(database, actor, added.user.id, context, now);
			return sent.kind === 'done'
				? { kind: 'done', user: added.user, invitation: sent.invitation }
				: sent;
		}
	}
}

function tellProviderSignIn(
	database: AppDatabase,
	actor: ConsoleUser,
	user: UserView,
	secretsKey: Buffer,
	now: number
): Invitation {
	const setup = emailSetup(database, secretsKey, 'queue');
	if (setup.kind === 'not-ready') {
		return { kind: 'none' };
	}
	const providers = signInProviders(database).map((provider) => provider.name);
	enqueueEmail(
		database,
		{
			kind: 'invitation',
			to: user.email,
			email: providerInvitationEmail(user.name, actor.name, providers, `${setup.consoleUrl}/login`)
		},
		{ kind: 'plain' },
		now
	);
	return { kind: 'emailed', to: user.email };
}

/**
 * Makes a new invitation link for someone with no password yet (earlier
 * links stop working), and emails it or returns it for the admin.
 */
export function inviteUser(
	database: AppDatabase,
	actor: ConsoleUser,
	userId: string,
	context: InviteContext,
	now: number
): { kind: 'done'; invitation: Invitation } | Refused {
	const setup = emailSetup(database, context.secretsKey, 'queue');
	return database.transaction((transaction) => {
		const user = findUserById(transaction, userId);
		if (user === undefined) {
			return { kind: 'refused', status: 404, message: 'No user with this id.' };
		}
		if (user.passwordHash !== null) {
			return {
				kind: 'refused',
				status: 409,
				message: 'They already have a password. Reset it from Edit instead.'
			};
		}
		if (user.disabledAt !== null) {
			return { kind: 'refused', status: 409, message: 'Enable them before inviting them.' };
		}
		const link = createPasswordLink(transaction, user.id, 'invitation', now);
		const path = linkPath('invitation', link.token);
		let invitation: Invitation;
		if (setup.kind === 'ready') {
			enqueueEmail(
				transaction,
				{
					kind: 'invitation',
					to: user.email,
					email: invitationEmail(
						user.name,
						actor.name,
						`${setup.consoleUrl}${path}`,
						INVITATION_LINK_DAYS
					)
				},
				{ kind: 'sealed', secretsKey: context.secretsKey },
				now
			);
			invitation = { kind: 'emailed', to: user.email };
		} else {
			invitation = {
				kind: 'link',
				url: `${context.adminOrigin}${path}`,
				expiresIso: link.expiresAt.toISOString()
			};
		}
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actor.id },
				kind: 'invitation-created',
				target: user.email,
				machineId: null,
				detail: { delivery: invitation.kind === 'emailed' ? 'email' : 'link for the admin' }
			},
			now
		);
		return { kind: 'done', invitation };
	});
}

/** What the invitation page shows before the person chooses a password. */
export type InvitationLookup =
	{ kind: 'usable'; name: string; email: string } | { kind: 'unusable' };

export function lookUpInvitation(
	database: AppDatabase,
	token: string,
	now: number
): InvitationLookup {
	const link = findUsableLink(database, token, 'invitation', now);
	return link.kind === 'usable'
		? { kind: 'usable', name: link.user.name, email: link.user.email }
		: link;
}

export type AcceptOutcome = { kind: 'accepted'; session: StartedSession } | { kind: 'unusable' };

/** Sets their password, uses up the link and signs them in. */
export async function acceptInvitation(
	database: AppDatabase,
	token: string,
	password: string,
	client: SignInClient,
	now: number
): Promise<AcceptOutcome> {
	if (findUsableLink(database, token, 'invitation', now).kind === 'unusable') {
		return { kind: 'unusable' };
	}
	const passwordHash = await hashPassword(password);
	return database.transaction((transaction) => {
		const link = findUsableLink(transaction, token, 'invitation', now);
		if (link.kind === 'unusable' || link.user.passwordHash !== null) {
			return { kind: 'unusable' };
		}
		setPasswordHash(transaction, link.user.id, passwordHash);
		usePasswordLinks(transaction, link.user.id, now);
		markSignedIn(transaction, link.user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: link.user.id },
				kind: 'invitation-accepted',
				target: link.user.email,
				machineId: null,
				detail: {}
			},
			now
		);
		return { kind: 'accepted', session: startSession(transaction, link.user.id, client, now) };
	});
}
