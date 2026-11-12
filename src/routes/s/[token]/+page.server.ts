import { error } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { LINK_ENDED_MESSAGE } from '#lib/server/guards/route.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import {
	GUEST_COOKIE,
	guestCookieMatches,
	guestCookieOptions,
	guestCookieValue
} from '#lib/server/services/share-links/guest-cookie.ts';
import {
	PAUSED_MESSAGE,
	recordShareLinkFailure,
	shareLinkPause
} from '#lib/server/services/share-links/share-link-limits.ts';
import {
	auditGuestOpened,
	guestViewOf,
	resolveShareToken
} from '#lib/server/services/share-links/share-links.ts';
import type { PageServerLoad, PageServerLoadEvent } from './$types';

/**
 * A share link's guest page (SPEC-SHARE-LINKS): public, because the token is
 * the key. A paused address is refused before the token is looked at; a
 * wrong, ended or expired token gets the same plain "This link has ended".
 * A browser without this link's guest cookie gets one, and that opening is
 * audited (address and browser). The token never leaves in a Referer, a
 * cache or a search index.
 */
export const load: PageServerLoad = page.public((event: PageServerLoadEvent) => {
	event.setHeaders({
		'referrer-policy': 'no-referrer',
		'cache-control': 'no-store',
		'x-robots-tag': 'noindex'
	});
	const client = signInClient(event);
	const now = Date.now();
	if (shareLinkPause(database, client.ip, now).kind === 'paused') {
		error(429, PAUSED_MESSAGE);
	}
	const resolved = resolveShareToken(database, sessionRelay(), event.params.token, now);
	if (resolved.kind === 'ended') {
		recordShareLinkFailure(database, client.ip, now);
		error(404, LINK_ENDED_MESSAGE);
	}
	const grant = resolved.grant;
	if (!guestCookieMatches(env.secretsKey, event.cookies.get(GUEST_COOKIE), grant.linkId, now)) {
		event.cookies.set(
			GUEST_COOKIE,
			guestCookieValue(env.secretsKey, grant.linkId, grant.expiresAt),
			guestCookieOptions(resolve('/s/[token]', { token: event.params.token }), grant.expiresAt, now)
		);
		auditGuestOpened(database, grant, client, now);
	}
	return { token: event.params.token, guest: guestViewOf(grant), nowMs: now };
});
