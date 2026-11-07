import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { enqueueEmail, queuedSince } from '../email/email-queue.ts';
import { passwordResetEmail, providerSignInEmail } from '../email/templates.ts';
import { emailSetup } from '../settings/email-settings.ts';
import { findUserByEmail, providerNamesOf, setPasswordHash } from '../users/users.ts';
import {
	createPasswordLink,
	findUsableLink,
	linkPath,
	RESET_LINK_MINUTES,
	usePasswordLinks
} from './password-links.ts';
import { hashPassword } from './passwords.ts';
import { endSessionsForUser } from './sessions.ts';

/**
 * Forgot password (SPEC-EMAIL E4). The reply never says whether the address
 * belongs to anyone: the page shows the same words either way. A password
 * account gets a single-use link that lasts 30 minutes; an account that
 * signs in through a provider is told to use it. One email per address per
 * few minutes, so the form cannot be used to flood someone's inbox. Links
 * point at the console address from the settings, never at the request's
 * Host header, which a stranger controls.
 */
const RESEND_AFTER_MS = 2 * 60_000;

export type ResetRequest = { kind: 'accepted' } | { kind: 'email-off' };

export function requestPasswordReset(
	database: AppDatabase,
	typedEmail: string,
	secretsKey: Buffer,
	now: number
): ResetRequest {
	const setup = emailSetup(database, secretsKey, 'queue');
	if (setup.kind === 'not-ready') {
		return { kind: 'email-off' };
	}
	database.transaction((transaction) => {
		const user = findUserByEmail(transaction, typedEmail);
		if (user?.disabledAt !== null) {
			return;
		}
		if (
			queuedSince(
				transaction,
				user.email,
				['password-reset', 'provider-sign-in'],
				now - RESEND_AFTER_MS
			)
		) {
			return;
		}
		if (user.passwordHash === null) {
			enqueueEmail(
				transaction,
				{
					kind: 'provider-sign-in',
					to: user.email,
					email: providerSignInEmail(
						user.name,
						providerNamesOf(transaction, user.id),
						`${setup.consoleUrl}/login`
					)
				},
				{ kind: 'plain' },
				now
			);
		} else {
			const link = createPasswordLink(transaction, user.id, 'reset', now);
			enqueueEmail(
				transaction,
				{
					kind: 'password-reset',
					to: user.email,
					email: passwordResetEmail(
						user.name,
						`${setup.consoleUrl}${linkPath('reset', link.token)}`,
						RESET_LINK_MINUTES
					)
				},
				{ kind: 'sealed', secretsKey },
				now
			);
		}
		recordAudit(
			transaction,
			{
				actor: { kind: 'system' },
				kind: 'password-reset-requested',
				target: user.email,
				machineId: null,
				detail: { emailed: user.passwordHash === null ? 'use your provider' : 'reset link' }
			},
			now
		);
	});
	return { kind: 'accepted' };
}

export type ResetOutcome = { kind: 'done' } | { kind: 'link-unusable' };

/** Sets the new password, uses up the link and signs the person out everywhere. */
export async function resetPassword(
	database: AppDatabase,
	token: string,
	password: string,
	now: number
): Promise<ResetOutcome> {
	if (findUsableLink(database, token, 'reset', now).kind === 'unusable') {
		return { kind: 'link-unusable' };
	}
	const passwordHash = await hashPassword(password);
	return database.transaction((transaction) => {
		// Checked again inside the transaction: the link is single-use.
		const link = findUsableLink(transaction, token, 'reset', now);
		if (link.kind === 'unusable') {
			return { kind: 'link-unusable' };
		}
		setPasswordHash(transaction, link.user.id, passwordHash);
		usePasswordLinks(transaction, link.user.id, now);
		endSessionsForUser(transaction, link.user.id);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: link.user.id },
				kind: 'password-reset',
				target: link.user.email,
				machineId: null,
				detail: {}
			},
			now
		);
		return { kind: 'done' };
	});
}
