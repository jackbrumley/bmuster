import { resolve } from '$app/paths';
import {
	IconActivity,
	IconAdjustments,
	IconCloudDownload,
	IconDevices,
	IconLock,
	IconLogin2,
	IconPlus,
	IconTerminal2,
	IconUsers,
	IconUsersGroup
} from '@tabler/icons-svelte-runes';
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
	| '/(console)/add'
	| '/(console)/users'
	| '/(console)/groups'
	| '/(console)/access'
	| '/(console)/sign-in'
	| '/(console)/updates'
	| '/(console)/settings';

export type NavItem = { route: NavRoute; label: string; icon: typeof IconDevices };

/**
 * The main pages. Commands (SPEC-COMMANDS C20) is shown to people who may run commands on
 * at least one machine; the server checks every run again.
 */
export function mainNav(role: ConsoleRole, runCommands: boolean): NavItem[] {
	const machines: NavItem = { route: '/(console)', label: 'Machines', icon: IconDevices };
	const activity: NavItem = { route: '/(console)/activity', label: 'Activity', icon: IconActivity };
	const commands: NavItem[] = runCommands
		? [{ route: '/(console)/commands', label: 'Commands', icon: IconTerminal2 }]
		: [];
	switch (role) {
		case 'admin':
			return [
				machines,
				activity,
				...commands,
				{ route: '/(console)/add', label: 'Add machine', icon: IconPlus }
			];
		case 'member':
			return [machines, activity, ...commands];
	}
}

export function adminNav(role: ConsoleRole): NavItem[] {
	switch (role) {
		case 'admin':
			return [
				{ route: '/(console)/users', label: 'Users', icon: IconUsers },
				{ route: '/(console)/groups', label: 'Groups', icon: IconUsersGroup },
				{ route: '/(console)/access', label: 'Access rules', icon: IconLock },
				{ route: '/(console)/sign-in', label: 'Sign-in', icon: IconLogin2 },
				{ route: '/(console)/updates', label: 'Updates', icon: IconCloudDownload },
				{ route: '/(console)/settings', label: 'Settings', icon: IconAdjustments }
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
