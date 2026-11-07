import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachines } from '#lib/server/services/machines/machine-views.ts';
import type { PageServerLoad } from './$types';

/**
 * Machines. Until access rules exist (SPEC-ACCESS) only admins see machines;
 * members see that their access has not been set up yet (SPEC-SIGN-IN 8.2).
 */
export const load: PageServerLoad = page.user((_event, { user }) => {
	const now = Date.now();
	switch (user.role) {
		case 'admin':
			return { now, view: { kind: 'machines' as const, machines: listMachines(database, now) } };
		case 'member':
			return { now, view: { kind: 'awaiting-access' as const } };
	}
});
