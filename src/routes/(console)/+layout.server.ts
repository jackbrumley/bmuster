import { canManageServer, machineIdsWith } from '#lib/server/services/access/access.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { approvalsNav } from '#lib/server/services/commands/approvers.ts';
import { assistantStatus } from '#lib/server/services/oauth/grants.ts';
import { getSetting } from '#lib/server/services/settings/settings.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Every console page needs a session (SPEC-SIGN-IN S7); the frame shows who
 * it is, the local network mode banner (SPEC-INSTALL-OPTIONS L3), and the Commands tab for
 * people who may run commands somewhere (SPEC-COMMANDS C20), and which AI assistant is working as
 * them right now (SPEC-MCP M15), and Approvals with its count for people who may approve an AI
 * assistant's command (SPEC-MCP M26).
 */
export const load: LayoutServerLoad = page.user((_event, { user }) => ({
	user,
	serverUpdate: canManageServer(user) ? serverUpdates().view() : null,
	localNetworkMode: getSetting(database, 'localNetworkMode'),
	runCommands: machineIdsWith(database, user, 'run-commands').size > 0,
	assistant: assistantStatus(database, user.id, Date.now()),
	approvals: approvalsNav(database, user)
}));
