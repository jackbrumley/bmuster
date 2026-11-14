import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { registerClient } from '#lib/server/services/oauth/clients.ts';
import { registrationAllowed } from '#lib/server/services/oauth/registration-limits.ts';
import { readJson } from '../../api/replies.server.ts';
import { oauthError, oauthJson } from '../oauth-replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /oauth/register (SPEC-MCP M6): Dynamic Client Registration, JSON, rate-limited per
 * address. The client is unverified and may do nothing until a person allows it.
 */
export const POST: RequestHandler = route.oauth(async ({ request, getClientAddress }) => {
	const now = Date.now();
	if (!registrationAllowed(getClientAddress(), now)) {
		return oauthError('too_many_requests', 'Too many registrations. Try again in an hour.', 429);
	}
	const registration = registerClient(database, await readJson(request), now);
	switch (registration.kind) {
		case 'registered':
			return oauthJson(registration.reply, 201);
		case 'refused':
			return oauthError(registration.error, registration.message, 400);
	}
});
