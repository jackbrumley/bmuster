import { database } from '#lib/server/database/app-database.ts';
import { listMachines } from '#lib/server/services/machines/machine-views.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const now = Date.now();
	return { now, machines: listMachines(database, now) };
};
