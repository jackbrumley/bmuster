import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { watchAgent } from '#lib/server/services/agents/live-agents.ts';
import { findMachine } from '#lib/server/services/machines/machine-views.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ params }) => {
	const now = Date.now();
	const machine = findMachine(database, params.id, now);
	if (machine === undefined) {
		error(404, 'No machine with this id');
	}
	watchAgent(machine.id);
	return { now, machine };
};
