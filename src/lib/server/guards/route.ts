import type { RequestEvent } from '@sveltejs/kit';
import { database } from '../database/app-database.ts';
import { authenticateAgent, type AuthenticatedAgent } from '../services/agents/agent-auth.ts';
import { isRefusal, refusalResponse } from '../services/agents/agent-refusal.ts';
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
