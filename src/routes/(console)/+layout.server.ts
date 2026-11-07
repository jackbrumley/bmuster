import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { getSetting } from '#lib/server/services/settings/settings.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Every console page needs a session (SPEC-SIGN-IN S7); the frame shows who
 * it is, and the local network mode banner (SPEC-INSTALL-OPTIONS L3).
 */
export const load: LayoutServerLoad = page.user((_event, { user }) => ({
	user,
	localNetworkMode: getSetting(database, 'localNetworkMode')
}));
