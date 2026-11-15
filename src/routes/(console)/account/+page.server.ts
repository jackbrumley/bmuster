import type { TwoFactorStatus } from '#lib/domain/auth/two-factor.ts';
import { mcpServerUrl, type ConnectState } from '#lib/domain/mcp/mcp.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listGrants } from '#lib/server/services/oauth/grants.ts';
import { connectEligibility, mcpEnabled } from '#lib/server/services/oauth/mcp-settings.ts';
import { otherSessionCount, SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { twoFactorStatus } from '#lib/server/services/auth/two-factor.ts';
import { findUserById, providerNamesOf } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/**
 * Account (SPEC-MCP 8.5, M10): every signed-in person's own page: who they are, how they sign
 * in, their two-factor sign-in (SPEC-TWO-FACTOR 2.6), where else they are signed in
 * (SPEC-SIGN-IN S21), and the AI assistants connected as them, with how to connect one.
 */
export const load: PageServerLoad = page.user(({ url, cookies }, { user }) => {
	const now = Date.now();
	// A signed-in person came with the session cookie; the guard read it.
	const sessionToken = cookies.get(SESSION_COOKIE);
	if (sessionToken === undefined) {
		throw new Error('A signed-in request without its session cookie');
	}
	const row = findUserById(database, user.id);
	const signIn = [
		...(row?.passwordHash === null ? [] : ['Password']),
		...providerNamesOf(database, user.id)
	];
	const twoFactor: TwoFactorStatus =
		row === undefined ? { kind: 'no-password', providerNames: [] } : twoFactorStatus(database, row);
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
		grants: listGrants(database, { kind: 'user', userId: user.id }, now),
		origin: url.origin,
		twoFactor,
		otherSessions: otherSessionCount(database, user.id, sessionToken, now)
	};
});
