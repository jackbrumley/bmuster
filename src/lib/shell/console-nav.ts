import { resolve } from '$app/paths';
import {
	IconActivity,
	IconAdjustments,
	IconDevices,
	IconLock,
	IconLogin2,
	IconPlus,
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
	| '/(console)/add'
	| '/(console)/users'
	| '/(console)/groups'
	| '/(console)/access'
	| '/(console)/sign-in'
	| '/(console)/settings';

export type NavItem = { route: NavRoute; label: string; icon: typeof IconDevices };

export function mainNav(role: ConsoleRole): NavItem[] {
	const machines: NavItem = { route: '/(console)', label: 'Machines', icon: IconDevices };
	switch (role) {
		case 'admin':
			return [
				machines,
				{ route: '/(console)/activity', label: 'Activity', icon: IconActivity },
				{ route: '/(console)/add', label: 'Add machine', icon: IconPlus }
			];
		case 'member':
			return [machines];
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
