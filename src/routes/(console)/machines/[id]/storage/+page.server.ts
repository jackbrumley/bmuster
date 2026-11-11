import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { permissionsFor } from '#lib/server/services/access/access.ts';
import { reportedStorage } from '#lib/server/services/machines/machine-storage.ts';
import type { PageServerLoad } from './$types';

/**
 * The Storage tab (SPEC-STORAGE 7): the last per-drive summary the machine reported, shown while
 * it is offline. Only for people with `files`, like everything else on the tab; the layout already
 * refused anyone who may not see the machine.
 */
export const load: PageServerLoad = page.user(({ params }, { user }) => {
	const grants = permissionsFor(database, user, params.id);
	const mayRead = grants.some((grant) => grant.permission === 'files');
	return {
		reported: mayRead ? reportedStorage(database, params.id) : { kind: 'none' as const }
	};
});
