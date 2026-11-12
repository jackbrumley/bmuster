import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '../database/app-database.ts';
import { canReadDiagnostics } from '../services/access/access.ts';
import { authenticateAgent, type AuthenticatedAgent } from '../services/agents/agent-auth.ts';
import { isRefusal, refusalResponse } from '../services/agents/agent-refusal.ts';
import {
	authenticateDiagnosticsToken,
	type TokenCheck
} from '../services/auth/diagnostics-tokens.ts';
import { env } from '../env.ts';
import { GUEST_COOKIE, guestCookieMatches } from '../services/share-links/guest-cookie.ts';
import {
	PAUSED_MESSAGE,
	recordShareLinkFailure,
	shareLinkPause
} from '../services/share-links/share-link-limits.ts';
import { resolveShareToken, type GuestGrant } from '../services/share-links/share-links.ts';
import { sessionRelay } from '../services/sessions/relay.ts';
import { apiRefusal, type SessionContext } from './checks.ts';

/**
 * Guards for `+server.ts` endpoints (SPEC-SIGN-IN S7). Every exported method
 * is built by one (hygiene: route-guard-required), so the access rule sits
 * next to the handler and the handler receives only what the guard proved:
 *
 * ```ts
 * export const POST: RequestHandler = route.admin(async (event, { user }) => …);
 * ```
 */
type Handler<E extends RequestEvent, C> = (event: E, context: C) => Response | Promise<Response>;

/** A signed agent request: the agent and the exact body bytes it signed. */
export type AgentContext = { agent: AuthenticatedAgent; body: Uint8Array };

/** Who reads diagnostics: a signed-in admin, or an admin's diagnostics token. */
export type DiagnosticsReader =
	| { kind: 'session'; user: ConsoleUser }
	| { kind: 'token'; tokenId: string; tokenName: string; user: ConsoleUser };

export type DiagnosticsContext = { reader: DiagnosticsReader };

/** A share link's guest (SPEC-SHARE-LINKS): one link, so one machine, still valid now. */
export type GuestContext = { grant: GuestGrant };

/** The same plain answer for every wrong, ended or cookie-less request (SL5, SL10). */
export const LINK_ENDED_MESSAGE = 'This link has ended.';

/**
 * SPEC-SHARE-LINKS D4, D5: rate limit first (a paused address is refused before the token is
 * looked at), then the token, then the guest cookie for the same link. The console cookie is
 * never read: a guest is not a console user. Failures are counted per address.
 */
function guestRefusal(
	event: RequestEvent & { params: { token: string } }
): Response | GuestContext {
	const address = event.getClientAddress();
	const now = Date.now();
	if (shareLinkPause(database, address, now).kind === 'paused') {
		return Response.json({ message: PAUSED_MESSAGE }, { status: 429 });
	}
	const resolved = resolveShareToken(database, sessionRelay(), event.params.token, now);
	if (
		resolved.kind === 'ended' ||
		!guestCookieMatches(env.secretsKey, event.cookies.get(GUEST_COOKIE), resolved.grant.linkId, now)
	) {
		recordShareLinkFailure(database, address, now);
		return Response.json({ message: LINK_ENDED_MESSAGE }, { status: 404 });
	}
	return { grant: resolved.grant };
}

const BEARER = /^Bearer (\S+)$/i;

/**
 * SPEC-AGENT-LOGS 4: a bearer diagnostics token, or else an admin's session cookie. A request
 * with an Authorization header is judged by the token alone. Only GET is let through.
 */
function diagnosticsRefusal(event: RequestEvent): Response | DiagnosticsContext {
	if (event.request.method !== 'GET') {
		return Response.json(
			{ message: 'Diagnostics endpoints only read.' },
			{ status: 405, headers: { allow: 'GET' } }
		);
	}
	const authorization = event.request.headers.get('authorization');
	if (authorization !== null) {
		const token = BEARER.exec(authorization)?.[1];
		const check: TokenCheck =
			token === undefined
				? { kind: 'invalid' }
				: authenticateDiagnosticsToken(database, token, Date.now());
		switch (check.kind) {
			case 'invalid':
				return Response.json(
					{ message: 'This diagnostics token is not valid, has expired or was revoked.' },
					{ status: 401, headers: { 'www-authenticate': 'Bearer' } }
				);
			case 'valid':
				return {
					reader: {
						kind: 'token',
						tokenId: check.tokenId,
						tokenName: check.tokenName,
						user: check.user
					}
				};
		}
	}
	const checked = apiRefusal(event, 'user');
	if (checked instanceof Response) {
		return checked;
	}
	if (!canReadDiagnostics(checked.user)) {
		return Response.json({ message: 'Only admins can do this.' }, { status: 403 });
	}
	return { reader: { kind: 'session', user: checked.user } };
}

export const route = {
	/** Open to anyone: sign-in steps, agent downloads, join-code enrolment. */
	public<E extends RequestEvent>(handler: Handler<E, null>) {
		return (event: E): Response | Promise<Response> => handler(event, null);
	},

	/** Any signed-in person (401 otherwise). */
	user<E extends RequestEvent>(handler: Handler<E, SessionContext>) {
		return (event: E): Response | Promise<Response> => {
			const checked = apiRefusal(event, 'user');
			return checked instanceof Response ? checked : handler(event, checked);
		};
	},

	/** Admins only (401 signed out, 403 for members). */
	admin<E extends RequestEvent>(handler: Handler<E, SessionContext>) {
		return (event: E): Response | Promise<Response> => {
			const checked = apiRefusal(event, 'admin');
			return checked instanceof Response ? checked : handler(event, checked);
		};
	},

	/**
	 * Read-only diagnostics (SPEC-AGENT-LOGS 4): GET handlers under /api/diagnostics only
	 * (hygiene: route-guard-required). The one guard that takes a diagnostics token.
	 */
	diagnostics<E extends RequestEvent>(handler: Handler<E, DiagnosticsContext>) {
		return (event: E): Response | Promise<Response> => {
			const checked = diagnosticsRefusal(event);
			return checked instanceof Response ? checked : handler(event, checked);
		};
	},

	/**
	 * A share link's guest (SPEC-SHARE-LINKS): routes under /s/[token]/ only. The token and
	 * the guest cookie for the same link, both re-checked on every request.
	 */
	guest<E extends RequestEvent & { params: { token: string } }>(handler: Handler<E, GuestContext>) {
		return (event: E): Response | Promise<Response> => {
			const checked = guestRefusal(event);
			return checked instanceof Response ? checked : handler(event, checked);
		};
	},

	/** An enrolled agent's signed request (SPEC-ENROLMENT 6), never a cookie. */
	agent<E extends RequestEvent>(handler: Handler<E, AgentContext>) {
		return async (event: E): Promise<Response> => {
			const body = new Uint8Array(await event.request.arrayBuffer());
			const agent = authenticateAgent(
				database,
				{
					method: event.request.method,
					path: event.url.pathname,
					authorization: event.request.headers.get('authorization'),
					body
				},
				Date.now()
			);
			return isRefusal(agent) ? refusalResponse(agent) : handler(event, { agent, body });
		};
	}
};
