import { error, redirect } from '@sveltejs/kit';
import { authorizeParamsSchema, type AuthorizeParams } from '#lib/schemas/mcp/oauth.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { consentView, decideConsent } from '#lib/server/services/oauth/authorize.ts';
import { safeFetchJson } from '#lib/server/services/oauth/safe-fetch.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The consent screen (SPEC-MCP M7): GET shows who is asking and what it may do; Allow and Cancel
 * post the same request back, which is checked again from scratch. Behind a console session,
 * with the origin check every console form gets.
 */

const FIELDS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'code_challenge',
	'code_challenge_method',
	'state',
	'resource',
	'scope'
] as const;

function paramsFrom(read: (name: string) => string | null): AuthorizeParams {
	const raw: Record<string, string> = {};
	for (const name of FIELDS) {
		const value = read(name);
		if (value !== null) raw[name] = value;
	}
	const parsed = authorizeParamsSchema.safeParse(raw);
	if (!parsed.success) {
		error(400, 'This sign-in request is not valid.');
	}
	return parsed.data;
}

/**
 * Sends the browser back to the assistant. The location is the client's own registered redirect
 * URI (checked before any redirect is made), so only its origin is allowed.
 */
function backToAssistant(location: string): never {
	redirect(303, location, { external: [new URL(location).origin] });
}

/** The request's fields, for the form to post back. */
function hiddenFields(params: AuthorizeParams): { name: string; value: string }[] {
	return FIELDS.flatMap((name) => {
		const value = params[name];
		return value === undefined ? [] : [{ name, value }];
	});
}

export const load: PageServerLoad = page.oauth(async ({ url }, { user }) => {
	const params = paramsFrom((name) => url.searchParams.get(name));
	const view = await consentView(database, user.id, params, url.origin, safeFetchJson, Date.now());
	if (view.kind === 'redirect') {
		backToAssistant(view.location);
	}
	return { view, fields: hiddenFields(params), userName: user.name };
});

async function decide(
	request: Request,
	origin: string,
	userId: string,
	allow: boolean
): Promise<{ kind: 'not-allowed'; assistantName: string } | { kind: 'invalid'; message: string }> {
	const form = await request.formData();
	const params = paramsFrom((name) => {
		const value = form.get(name);
		return typeof value === 'string' ? value : null;
	});
	const decision = await decideConsent(
		database,
		{ userId, allow, params },
		origin,
		safeFetchJson,
		Date.now()
	);
	if (decision.kind === 'redirect') {
		backToAssistant(decision.location);
	}
	switch (decision.kind) {
		case 'invalid':
			return { kind: 'invalid', message: decision.message };
		case 'not-allowed':
			return { kind: 'not-allowed', assistantName: decision.assistant.name };
	}
}

export const actions = {
	allow: page.oauth(({ request, url }, { user }) => decide(request, url.origin, user.id, true)),
	cancel: page.oauth(({ request, url }, { user }) => decide(request, url.origin, user.id, false))
} satisfies Actions;
