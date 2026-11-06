import { prototypeUserGroups, prototypeUsers } from '#lib/prototype/prototype-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	const now = Date.now();
	return { now, users: prototypeUsers(now), userGroups: prototypeUserGroups() };
};
