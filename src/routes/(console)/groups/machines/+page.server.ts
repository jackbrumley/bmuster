import { page } from '#lib/server/guards/page.ts';
import { groupsData } from '../groups-data.server.ts';
import type { PageServerLoad } from './$types';

/** Machines tab of Groups (SPEC-ACCESS A1–A3, A8); admins only. */
export const load: PageServerLoad = page.admin(() => groupsData());
