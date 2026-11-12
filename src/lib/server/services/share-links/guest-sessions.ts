import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import type { BrowserTicketReply } from '#lib/schemas/sessions/sessions.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import { getSetting } from '../settings/settings.ts';
import type { Relay, SessionRecord } from '../sessions/relay.ts';
import {
	canAskAtScreen,
	startSession,
	type OpenSessionResult,
	type SessionTerms
} from '../sessions/sessions.ts';
import { guestNameOf, sweepShareLinks, type GuestGrant } from './share-links.ts';

/**
 * A share link's guest on the machine's desktop (SPEC-SHARE-LINKS SL11–SL13).
 * The guest's session is an ordinary desktop session: the same signed ticket,
 * relay and sockets, but its terms come from the link alone and it always
 * asks the person at the screen first (D1). One session per link (D6).
 */

/**
 * SL11: what the guest's ticket carries. Only the link's desktop permissions, control only
 * on a control link asking for it, and consent `ask` whatever the machine's rules say.
 */
export function guestDesktopTerms(
	grant: GuestGrant,
	mode: DesktopMode,
	notice: boolean
): SessionTerms {
	const control = mode === 'control' && grant.permissions.includes('desktop-control');
	return {
		permissions: control ? ['desktop-view', 'desktop-control'] : ['desktop-view'],
		purpose: { kind: 'desktop', consent: 'ask', notice }
	};
}

/** SL12–SL13: opens the link's desktop session, ending any it already has (another tab's). */
export function openGuestDesktop(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	grant: GuestGrant,
	mode: DesktopMode,
	ip: string,
	now: number
): OpenSessionResult {
	if (mode === 'control' && !grant.permissions.includes('desktop-control')) {
		return { kind: 'refused', status: 403, message: 'This link only lets you watch the screen.' };
	}
	if (!canAskAtScreen()) {
		return {
			kind: 'refused',
			status: 409,
			message: `The person at this computer must allow each connection, and this server cannot ask them yet. Ask ${grant.sharedBy.name} for another way in.`
		};
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
		userName: guestNameOf(grant),
		viewer: { kind: 'guest', shareLinkId: grant.linkId, sharedByUserId: grant.sharedBy.id },
		kind: 'desktop',
		mode,
		ip,
		openedAt: now
	};
	const opened = startSession(
		database,
		relay,
		secretsKey,
		record,
		grant.machineName,
		guestDesktopTerms(grant, mode, getSetting(database, 'connectedNotice')),
		now
	);
	if (opened.kind === 'opened') {
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
