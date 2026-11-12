import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachineGroups, listUserGroups } from '#lib/server/services/access/groups.ts';
import { listAccessRules, newRuleDefaults } from '#lib/server/services/access/rules.ts';
import { listAllActiveShareLinks } from '#lib/server/services/share-links/share-links.ts';
import type { PageServerLoad } from './$types';

/**
 * Access rules (SPEC-ACCESS A4); admins only. A new rule starts from the
 * server's Default for new access rules setting. Every active share link is
 * listed here too, so admins see all of them in one place (SPEC-SHARE-LINKS SL15).
 */
export const load: PageServerLoad = page.admin(() => {
	const now = Date.now();
	return {
		now,
		rules: listAccessRules(database),
		userGroups: listUserGroups(database).map((group) => ({ id: group.id, name: group.name })),
		machineGroups: listMachineGroups(database).map((group) => ({ id: group.id, name: group.name })),
		defaults: newRuleDefaults(database),
		activeShareLinks: listAllActiveShareLinks(database, now)
	};
});
