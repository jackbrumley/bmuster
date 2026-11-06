import { error } from '@sveltejs/kit';
import { prototypeMachines } from '#lib/prototype/prototype-data.ts';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ params }) => {
	const now = Date.now();
	const machine = prototypeMachines(now).find((candidate) => candidate.id === params.id);
	if (machine === undefined) {
		error(404, 'No machine with this id');
	}
	return { now, machine };
};
