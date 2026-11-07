import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachineGroups, listUserGroups } from '#lib/server/services/access/groups.ts';
import { activeMachineNames } from '#lib/server/services/machines/machine-views.ts';
import { listRules } from '#lib/server/services/notifications/notification-rules.ts';
import { emailReadiness } from '#lib/server/services/settings/email-settings.ts';
import type { PageServerLoad } from './$types';

/**
 * Settings → Notifications (SPEC-EMAIL E6): the rules, and the groups and
 * machines a rule can name. Admins only.
 */
export const load: PageServerLoad = page.admin(() => ({
	rules: listRules(database),
	emailReady: emailReadiness(database).kind === 'ready',
	userGroups: listUserGroups(database).map((group) => ({ id: group.id, name: group.name })),
	machineGroups: listMachineGroups(database).map((group) => ({ id: group.id, name: group.name })),
	machines: [...activeMachineNames(database)].map(([id, name]) => ({ id, name }))
}));
