import { mcpServerUrl } from '#lib/domain/mcp/mcp.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listUserGroups } from '#lib/server/services/access/groups.ts';
import { listGrants } from '#lib/server/services/oauth/grants.ts';
import { approverSettingsView, mcpSettingsView } from '#lib/server/services/oauth/mcp-settings.ts';
import type { PageServerLoad } from './$types';

/**
 * Settings → AI assistants (SPEC-MCP 8.5, M1, M10, M14), admins only: whether assistants may
 * connect and who may connect one, who may approve their commands, every connected assistant, and
 * Stop all AI access.
 */
export const load: PageServerLoad = page.admin(({ url }) => {
	const now = Date.now();
	return {
		now,
		settings: mcpSettingsView(database),
		approvers: approverSettingsView(database),
		groups: listUserGroups(database).map((group) => ({ id: group.id, name: group.name })),
		grants: listGrants(database, { kind: 'all' }, now),
		serverUrl: mcpServerUrl(url.origin)
	};
});
