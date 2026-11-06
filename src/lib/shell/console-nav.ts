import { resolve } from '$app/paths';
import {
	IconActivity,
	IconDevices,
	IconLock,
	IconPlus,
	IconSettings,
	IconUsers,
	IconUsersGroup
} from '@tabler/icons-svelte-runes';

/** The console's navigation, shared by the sidebar, the tab bar and the "More" page. */

type NavRoute =
	| '/(console)'
	| '/(console)/activity'
	| '/(console)/add'
	| '/(console)/users'
	| '/(console)/groups'
	| '/(console)/access'
	| '/(console)/settings';

export type NavItem = { route: NavRoute; label: string; icon: typeof IconDevices };

export function mainNav(): NavItem[] {
	return [
		{ route: '/(console)', label: 'Machines', icon: IconDevices },
		{ route: '/(console)/activity', label: 'Activity', icon: IconActivity },
		{ route: '/(console)/add', label: 'Add machine', icon: IconPlus }
	];
}

export function adminNav(): NavItem[] {
	return [
		{ route: '/(console)/users', label: 'Users', icon: IconUsers },
		{ route: '/(console)/groups', label: 'Groups', icon: IconUsersGroup },
		{ route: '/(console)/access', label: 'Access rules', icon: IconLock },
		{ route: '/(console)/settings', label: 'Sign-in', icon: IconSettings }
	];
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
