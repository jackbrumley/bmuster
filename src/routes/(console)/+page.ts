import { prototypeMachines } from '#lib/prototype/prototype-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	const now = Date.now();
	return { now, machines: prototypeMachines(now) };
};
