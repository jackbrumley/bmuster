import { resolve } from '$app/paths';
import {
	IconActivity,
	IconAdjustments,
	IconChecklist,
	IconCloudDownload,
	IconDevices,
	IconLock,
	IconLogin2,
	IconPlus,
	IconTerminal2,
	IconUsers,
	IconUsersGroup
} from '@tabler/icons-svelte-runes';
import type { ApprovalsNav } from '#lib/domain/commands/assistant-runs.ts';
import type { ConsoleRole } from '#lib/domain/users/user.ts';

/**
 * The console's navigation, shared by the sidebar, the tab bar and the
 * "More" page. Admin-only pages are left out for members; the guards refuse
 * them anyway, this only keeps the menu honest.
 */

type NavRoute =
	| '/(console)'
	| '/(console)/activity'
	| '/(console)/commands'
	| '/(console)/approvals'
	| '/(console)/add'
	| '/(console)/users'
	| '/(console)/groups'
	| '/(console)/access'
	| '/(console)/sign-in'
	| '/(console)/updates'
	| '/(console)/settings';

/** `badge`: how many things wait there for the person (0 shows none). */
export type NavItem = { route: NavRoute; label: string; icon: typeof IconDevices; badge: number };

function item(route: NavRoute, label: string, icon: typeof IconDevices): NavItem {
	return { route, label, icon, badge: 0 };
}

/**
 * The main pages. Commands (SPEC-COMMANDS C20) is shown to people who may run commands on
 * at least one machine; Approvals (SPEC-MCP M26) to people who may approve an AI assistant's
 * command, with how many wait. The server checks everything again.
 */
export function mainNav(
	role: ConsoleRole,
	runCommands: boolean,
	approvals: ApprovalsNav
): NavItem[] {
	const machines = item('/(console)', 'Machines', IconDevices);
	const activity = item('/(console)/activity', 'Activity', IconActivity);
	const commands: NavItem[] = runCommands
		? [item('/(console)/commands', 'Commands', IconTerminal2)]
		: [];
	const approving: NavItem[] =
		approvals.kind === 'shown'
			? [{ ...item('/(console)/approvals', 'Approvals', IconChecklist), badge: approvals.pending }]
			: [];
	switch (role) {
		case 'admin':
			return [
				machines,
				activity,
				...commands,
				...approving,
				item('/(console)/add', 'Add machine', IconPlus)
			];
		case 'member':
			return [machines, activity, ...commands, ...approving];
	}
}

export function adminNav(role: ConsoleRole): NavItem[] {
	switch (role) {
		case 'admin':
			return [
				item('/(console)/users', 'Users', IconUsers),
				item('/(console)/groups', 'Groups', IconUsersGroup),
				item('/(console)/access', 'Access rules', IconLock),
				item('/(console)/sign-in', 'Sign-in', IconLogin2),
				item('/(console)/updates', 'Updates', IconCloudDownload),
				item('/(console)/settings', 'Settings', IconAdjustments)
			];
		case 'member':
			return [];
	}
}

/** True when `pathname` is on the page `route` points at (Machines also covers machine pages). */
export function isCurrent(pathname: string, route: NavRoute): boolean {
	const href = resolve(route);
	if (route === '/(console)') {
		return pathname === href || pathname.startsWith(`${href}machines/`);
	}
	return pathname.startsWith(href);
}

export const VERSION = __BMUSTER_VERSION__;
