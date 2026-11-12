import { eq } from 'drizzle-orm';
import { guestLabel, type GuestIdentity } from '#lib/domain/share-links/share-links.ts';
import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import type { BrowserTicketReply } from '#lib/schemas/sessions/sessions.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { shareLinks } from '../../database/schema.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import type { SignInClient } from '../auth/client.ts';
import type { Relay, SessionRecord } from '../sessions/relay.ts';
import { startSession, type OpenSessionResult, type SessionTerms } from '../sessions/sessions.ts';
import { sweepShareLinks, type GuestGrant } from './share-links.ts';

/**
 * A share link's guest on the machine's desktop (SPEC-SHARE-LINKS SL11–SL13).
 * The guest's session is an ordinary desktop session: the same signed ticket,
 * relay and sockets, but its terms come from the link alone. By the owner's
 * decision (D1, 2026-11-12) it connects without asking the person at the
 * screen, who is always shown that the guest is connected and can disconnect
 * them. One session per link (D6).
 */

/** How much of the browser's user agent is kept (D17). */
const GUEST_USER_AGENT_MAX_LENGTH = 300;

/**
 * SL11: what the guest's ticket carries. Only the link's desktop permissions, control only
 * on a control link asking for it, no consent prompt, and the connected notice always on
 * whatever the server's setting says (D1).
 */
export function guestDesktopTerms(grant: GuestGrant, mode: DesktopMode): SessionTerms {
	const control = mode === 'control' && grant.permissions.includes('desktop-control');
	return {
		permissions: control ? ['desktop-view', 'desktop-control'] : ['desktop-view'],
		purpose: { kind: 'desktop', consent: 'unattended', notice: true }
	};
}

/**
 * SL12–SL13, SL20: opens the link's desktop session, ending any it already has (another
 * tab's). The guest's typed name and company, address and browser are kept on the session,
 * its audit entry and the link's last use.
 */
export function openGuestDesktop(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	grant: GuestGrant,
	request: { mode: DesktopMode; identity: GuestIdentity },
	client: SignInClient,
	now: number
): OpenSessionResult {
	if (request.mode === 'control' && !grant.permissions.includes('desktop-control')) {
		return { kind: 'refused', status: 403, message: 'This link only lets you watch the screen.' };
	}
	if (!isAgentConnected(grant.machineId)) {
		return { kind: 'refused', status: 409, message: 'This computer is offline. Try again later.' };
	}
	for (const sessionId of relay.sessionsOf(grant.linkId)) {
		relay.end(sessionId, 'closed', 'The link was opened in another window.');
	}
	const record: SessionRecord = {
		id: crypto.randomUUID(),
		machineId: grant.machineId,
		userId: grant.linkId,
		userName: guestLabel(request.identity, grant.sharedBy.name),
		viewer: {
			kind: 'guest',
			shareLinkId: grant.linkId,
			sharedBy: grant.sharedBy,
			identity: request.identity,
			userAgent: client.userAgent.slice(0, GUEST_USER_AGENT_MAX_LENGTH)
		},
		kind: 'desktop',
		mode: request.mode,
		ip: client.ip,
		openedAt: now
	};
	const opened = startSession(
		database,
		relay,
		secretsKey,
		record,
		grant.machineName,
		guestDesktopTerms(grant, request.mode),
		now
	);
	if (opened.kind === 'opened') {
		database
			.update(shareLinks)
			.set({
				lastGuestName: request.identity.name,
				lastGuestCompany: request.identity.company,
				lastGuestAddress: client.ip,
				lastUsedAt: new Date(now)
			})
			.where(eq(shareLinks.id, grant.linkId))
			.run();
		// The session ends at the link's exact end, not up to a sweep later (D7).
		const timer = setTimeout(
			() => {
				sweepShareLinks(database, relay, Date.now());
			},
			Math.max(0, grant.expiresAt - now)
		);
		timer.unref();
	}
	return opened;
}

/** A fresh browser ticket for the link's own running session (a reload reattaches). */
export function guestBrowserTicket(
	relay: Relay,
	grant: GuestGrant,
	sessionId: string
): BrowserTicketReply {
	const browserTicket = relay.issueBrowserTicket(sessionId, grant.linkId);
	if (browserTicket !== undefined) {
		return { kind: 'issued', browserTicket };
	}
	const ended = relay.endedSession(sessionId);
	return {
		kind: 'ended',
		message: ended?.userId === grant.linkId ? ended.message : 'This session has ended.'
	};
}
