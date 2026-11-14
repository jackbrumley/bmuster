import {
	DEFAULT_SCOPES,
	isMcpScope,
	mcpServerUrl,
	type AssistantName,
	type McpScope,
	type RedirectTarget
} from '#lib/domain/mcp/mcp.ts';
import { PKCE_CHALLENGE, type AuthorizeParams } from '#lib/schemas/mcp/oauth.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { allowsRedirect, isLoopbackRedirect, resolveClient, type ClientRecord } from './clients.ts';
import { allowClient, refuseClient } from './grants.ts';
import { connectEligibility } from './mcp-settings.ts';
import type { FetchJson } from './safe-fetch.ts';

/**
 * `/oauth/authorize` (SPEC-MCP M7, M8). The client and redirect URI are checked first: while
 * either is wrong nothing is sent anywhere and the page says what is wrong. After that, every
 * problem goes back to the client as an OAuth error on its redirect URI, with `state` and `iss`.
 * PKCE `S256` and `resource` (exactly this server's `/mcp`) are required.
 */

export type ValidAuthorize = {
	client: ClientRecord;
	redirectUri: string;
	codeChallenge: string;
	state: string | null;
	resource: string;
	scopes: McpScope[];
};

export type AuthorizeCheck =
	| { kind: 'invalid'; message: string }
	| { kind: 'redirect'; location: string }
	| { kind: 'valid'; request: ValidAuthorize };

/** The redirect URI with these parameters added, keeping any query it already has. */
export function withParameters(redirectUri: string, parameters: Record<string, string>): string {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(parameters)) {
		url.searchParams.set(name, value);
	}
	return url.toString();
}

function errorRedirect(
	redirectUri: string,
	state: string | undefined,
	issuer: string,
	error: string,
	description: string
): AuthorizeCheck {
	return {
		kind: 'redirect',
		location: withParameters(redirectUri, {
			error,
			error_description: description,
			...(state === undefined ? {} : { state }),
			iss: issuer
		})
	};
}

/** Scopes asked for, or the default; undefined when one is unknown. */
function requestedScopes(scope: string | undefined): McpScope[] | undefined {
	if (scope === undefined || scope.trim() === '') {
		return [...DEFAULT_SCOPES];
	}
	const names = [...new Set(scope.split(' ').filter((name) => name !== ''))];
	const known = names.filter(isMcpScope);
	if (known.length !== names.length) {
		return undefined;
	}
	return known.includes('machines:read') ? known : ['machines:read', ...known];
}

export async function checkAuthorize(
	database: Queryable,
	params: AuthorizeParams,
	origin: string,
	fetchJson: FetchJson,
	now: number
): Promise<AuthorizeCheck> {
	if (params.client_id === undefined || params.client_id === '') {
		return { kind: 'invalid', message: 'The assistant did not say who it is (client_id).' };
	}
	const lookup = await resolveClient(database, params.client_id, fetchJson, now);
	if (lookup.kind === 'unknown') {
		return { kind: 'invalid', message: lookup.message };
	}
	const client = lookup.client;
	if (params.redirect_uri === undefined || !allowsRedirect(client, params.redirect_uri)) {
		return {
			kind: 'invalid',
			message: 'The assistant asked to return to an address it did not register (redirect_uri).'
		};
	}
	const redirectUri = params.redirect_uri;
	const fail = (error: string, description: string): AuthorizeCheck =>
		errorRedirect(redirectUri, params.state, origin, error, description);
	if (params.response_type !== 'code') {
		return fail('unsupported_response_type', 'Only response_type=code is supported.');
	}
	if (params.code_challenge_method !== 'S256') {
		return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
	}
	if (params.code_challenge === undefined || !PKCE_CHALLENGE.test(params.code_challenge)) {
		return fail('invalid_request', 'A code_challenge (S256) is required.');
	}
	if (params.resource !== mcpServerUrl(origin)) {
		return fail('invalid_target', `The resource must be ${mcpServerUrl(origin)}.`);
	}
	const scopes = requestedScopes(params.scope);
	if (scopes === undefined) {
		return fail('invalid_scope', 'Only machines:read and offline_access can be asked for.');
	}
	return {
		kind: 'valid',
		request: {
			client,
			redirectUri,
			codeChallenge: params.code_challenge,
			state: params.state ?? null,
			resource: params.resource,
			scopes
		}
	};
}

/** What the consent screen shows (M7), or why it cannot ask. */
export type ConsentView =
	| { kind: 'invalid'; message: string }
	| { kind: 'redirect'; location: string }
	| { kind: 'not-allowed'; assistant: AssistantName }
	| {
			kind: 'ask';
			assistant: AssistantName;
			redirect: RedirectTarget;
			scopes: McpScope[];
	  };

export function redirectTarget(redirectUri: string): RedirectTarget {
	return isLoopbackRedirect(redirectUri)
		? { kind: 'loopback' }
		: { kind: 'web', host: new URL(redirectUri).host };
}

export async function consentView(
	database: Queryable,
	userId: string,
	params: AuthorizeParams,
	origin: string,
	fetchJson: FetchJson,
	now: number
): Promise<ConsentView> {
	const check = await checkAuthorize(database, params, origin, fetchJson, now);
	if (check.kind !== 'valid') {
		return check;
	}
	if (connectEligibility(database, userId).kind === 'ineligible') {
		return { kind: 'not-allowed', assistant: check.request.client.assistant };
	}
	return {
		kind: 'ask',
		assistant: check.request.client.assistant,
		redirect: redirectTarget(check.request.redirectUri),
		scopes: check.request.scopes
	};
}

export type Decision =
	| { kind: 'redirect'; location: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'not-allowed'; assistant: AssistantName };

/**
 * Allow or Cancel (M2, M7, M8). The request is checked again from scratch; Allow from someone
 * who may not connect is refused and audited. Both answers go back with `state` and `iss`.
 */
export async function decideConsent(
	database: AppDatabase,
	decision: { userId: string; allow: boolean; params: AuthorizeParams },
	origin: string,
	fetchJson: FetchJson,
	now: number
): Promise<Decision> {
	const check = await checkAuthorize(database, decision.params, origin, fetchJson, now);
	if (check.kind !== 'valid') {
		return check;
	}
	const request = check.request;
	const back = (parameters: Record<string, string>): Decision => ({
		kind: 'redirect',
		location: withParameters(request.redirectUri, {
			...parameters,
			...(request.state === null ? {} : { state: request.state }),
			iss: origin
		})
	});
	if (!decision.allow) {
		refuseClient(
			database,
			{ userId: decision.userId, client: request.client, reason: 'cancelled' },
			now
		);
		return back({ error: 'access_denied', error_description: 'The person did not allow it.' });
	}
	if (connectEligibility(database, decision.userId).kind === 'ineligible') {
		refuseClient(
			database,
			{ userId: decision.userId, client: request.client, reason: 'not-allowed' },
			now
		);
		return { kind: 'not-allowed', assistant: request.client.assistant };
	}
	const code = allowClient(
		database,
		{
			userId: decision.userId,
			client: request.client,
			scopes: request.scopes,
			redirectUri: request.redirectUri,
			codeChallenge: request.codeChallenge,
			resource: request.resource
		},
		now
	);
	return back({ code });
}
