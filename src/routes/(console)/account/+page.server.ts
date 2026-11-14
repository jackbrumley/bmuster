import { mcpServerUrl, type ConnectState } from '#lib/domain/mcp/mcp.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listGrants } from '#lib/server/services/oauth/grants.ts';
import { connectEligibility, mcpEnabled } from '#lib/server/services/oauth/mcp-settings.ts';
import { findUserById, providerNamesOf } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/**
 * Account (SPEC-MCP 8.5, M10): every signed-in person's own page: who they are, how they sign
 * in, and the AI assistants connected as them, with how to connect one.
 */
export const load: PageServerLoad = page.user(({ url }, { user }) => {
	const now = Date.now();
	const row = findUserById(database, user.id);
	const signIn = [
		...(row?.passwordHash === null ? [] : ['Password']),
		...providerNamesOf(database, user.id)
	];
	const connect: ConnectState = !mcpEnabled(database)
		? 'off'
		: connectEligibility(database, user.id).kind === 'eligible'
			? 'on'
			: 'not-allowed';
	return {
		now,
		signIn,
		connect,
		serverUrl: mcpServerUrl(url.origin),
		grants: listGrants(database, { kind: 'user', userId: user.id }, now)
	};
});
