import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { visibleMachineIds } from '#lib/server/services/access/access.ts';
import { listMachines } from '#lib/server/services/machines/machine-views.ts';
import type { PageServerLoad } from './$types';

/**
 * Machines: every machine the person may see (SPEC-ACCESS A6). A member who
 * can see none is told their access has not been set up yet (SPEC-SIGN-IN 8.2);
 * an admin with none is offered Add machine.
 */
export const load: PageServerLoad = page.user((_event, { user }) => {
	const now = Date.now();
	const visible = visibleMachineIds(database, user);
	const machines = listMachines(database, now).filter((machine) => visible.has(machine.id));
	if (machines.length === 0 && user.role === 'member') {
		return { now, view: { kind: 'awaiting-access' as const } };
	}
	return { now, view: { kind: 'machines' as const, machines } };
});
