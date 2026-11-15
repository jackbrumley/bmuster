import type { Permission } from '#lib/domain/access/access.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { startSession } from '#lib/server/services/auth/sessions.ts';
import type { StorageToolContext } from '#lib/server/services/mcp/storage-tools.ts';
import { createRescanLimits, type RescanLimits } from '#lib/server/services/mcp/tool-limits.ts';
import { authenticateAccessToken, type McpPrincipal } from '#lib/server/services/oauth/tokens.ts';
import type {
	CleanupAssistantContext,
	CleanupDeciderContext
} from '#lib/server/services/sessions/cleanup-requests.ts';
import { createFilesChannels } from '#lib/server/services/sessions/files-channel.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from './access.ts';
import { NO_RELEASES } from './fake-agent.ts';
import { fakeAgent, SECRETS_KEY, setUpFiles } from './files-agent.ts';
import { connectAssistant, enableMcp, ORIGIN } from './mcp.ts';
import { addTestUser, NOW } from './people.ts';

/**
 * An assistant using storage (SPEC-MCP M49–M56): Pat's assistant on one machine with a fake
 * files agent (SPEC-STORAGE's scan of `/`), Kim beside her, and the contexts the storage tools,
 * the clean-up requests and a person deciding in the console are given.
 */

export const MINUTE = 60_000;

export async function setUpStorageAssistant(patPermissions: Permission[]) {
	const { database, admin, pat, machineId, relay } = await setUpFiles();
	const kim = toConsoleUser(
		await addTestUser(database, { email: 'kim@example.com', role: 'member', password: null })
	);
	const rule = grantAccess(database, {
		adminId: admin.id,
		name: 'Pat storage',
		memberIds: [pat.id],
		machineIds: [machineId],
		permissions: patPermissions,
		consent: 'unattended'
	});
	enableMcp(database, admin.id, [pat.id, kim.id]);
	const agent = fakeAgent(relay, machineId);
	const channels = createFilesChannels(relay, { idleMs: 60_000 });
	const clock = { now: NOW };
	const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
	const check = authenticateAccessToken(
		database,
		connection.accessToken,
		{ ip: '198.51.100.7', userAgent: 'Claude Code' },
		NOW
	);
	if (check.kind !== 'valid') throw new Error('The assistant did not authenticate');
	const principal: McpPrincipal = check.principal;
	const sessionOf = (user: ConsoleUser): string =>
		startSession(database, user.id, { ip: '192.0.2.2', userAgent: 'Vitest' }, NOW).token;
	const sessions = new Map<string, string>();
	const files = { relay, channels, secretsKey: SECRETS_KEY, ip: '192.0.2.9' };

	/** The storage tools' context for Pat's assistant; `waitMs` 0 answers at once. */
	const tools = (waitMs = 0, rescans: RescanLimits = createRescanLimits(10 * MINUTE)) =>
		({
			database,
			principal,
			releases: NO_RELEASES,
			...files,
			origin: ORIGIN,
			clock: () => clock.now,
			waitMs,
			rescans
		}) satisfies StorageToolContext;

	const asking = (): CleanupAssistantContext => ({
		database,
		...files,
		principal,
		now: clock.now
	});

	/** A person deciding in the console, signed in at NOW. */
	const deciding = (user: ConsoleUser): CleanupDeciderContext => {
		const token = sessions.get(user.id) ?? sessionOf(user);
		sessions.set(user.id, token);
		return { database, ...files, user, sessionToken: token, now: clock.now };
	};

	return {
		database,
		admin,
		pat,
		kim,
		machineId,
		rule,
		agent,
		clock,
		connection,
		principal,
		tools,
		asking,
		deciding
	};
}
